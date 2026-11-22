import { createHash } from "crypto";
import { open, type FileHandle } from "fs/promises";
import { AUDIT_LOG_PATH } from "./audit";

/**
 * Read-only pagination over the append-only JSON-lines audit log, newest
 * first. The log can grow unbounded, so each call scans one bounded byte
 * window and returns a cursor for the next older window — the same
 * stateless-resumable shape the Drive/sharing scans use, with the client
 * looping.
 *
 * The log rotates (audit.ts moves audit.log to audit.log.1, .1 to .2 and so
 * on), so the walk covers the live file and then every archive, oldest last.
 *
 * A cursor names the file it points into by identity, not by name: a rotation
 * between two calls renames the file the cursor was reading, and a byte offset
 * applied to whatever is called audit.log afterwards would hand back newer
 * entries as "older" ones. The identity is a hash of the file's first line,
 * which never changes once written and moves with the file when it is
 * renamed. A cursor whose file is gone (rotated off the end, or truncated by
 * hand) restarts the walk from the newest entry, and says so.
 *
 * Concurrent appends are safe: the first call snapshots the live file's size
 * and every later window lies strictly before it, so writers only ever add
 * bytes past the region being read.
 */

const SCAN_WINDOW_BYTES = 512 * 1024;
const DEFAULT_MAX_ENTRIES = 200;
/**
 * audit.ts keeps three archives (audit.log.1 … .3). Look a little further so
 * a larger setting, or a failed rotation that left a gap in the numbering,
 * still has every archive read.
 */
const MAX_ARCHIVE_INDEX = 9;
/** How much of a file's first line goes into its identity. */
const IDENTITY_PREFIX_BYTES = 4096;
/**
 * Entries are appended when their requests finish, which can trail their
 * timestamps by a few milliseconds under concurrency: an entry this close to
 * the `fromMs` bound never counts towards stopping the walk.
 */
const FROM_BOUND_SLACK_MS = 5_000;
/**
 * How many consecutive entries older than `fromMs` end a walk early. One is
 * not enough: a clock stepped backwards writes entries that look older than
 * the ones before them, and stopping on the first of those would hide every
 * in-range entry written before the step.
 */
const FROM_BOUND_STREAK = 200;

export interface AuditLogFilters {
  /** Case-insensitive substring match on the entry's action. */
  action?: string;
  outcome?: "success" | "error";
  /** Exact tenant id match. */
  tenantId?: string;
  /** Inclusive lower bound on the entry timestamp, epoch millis. */
  fromMs?: number;
  /** Inclusive upper bound on the entry timestamp, epoch millis. */
  toMs?: number;
}

/** Where the next (older) window ends. */
export interface AuditCursor {
  /** Identity of the file the window is in (see `fileIdentity`). */
  file: string;
  /** Byte offset in that file the window ends at (exclusive). */
  offset: number;
}

export interface AuditLogPage {
  /** Parsed entries in this window that matched the filters, newest first. */
  entries: Array<Record<string, unknown>>;
  /** Where the next older page starts; null when done. */
  nextCursor: AuditCursor | null;
  /** Bytes of the log consumed by this call. */
  scannedBytes: number;
  /** Lines in the window that failed to parse and were skipped. */
  skippedLines: number;
  done: boolean;
  /**
   * The walk ended at the `fromMs` bound rather than at the start of the
   * oldest archive: everything further back is older than the filter.
   */
  reachedFromBound: boolean;
  /**
   * Timestamp of the furthest-back entry this call read, whether or not it
   * matched — how far back the search has got. Null when no entry in the
   * window carried a timestamp.
   */
  oldestScannedTs: string | null;
  /**
   * The cursor's file was no longer there (rotated off the end, or truncated),
   * so this page starts again from the newest entry. A caller that is
   * appending pages should replace what it has instead.
   */
  restarted: boolean;
}

const CURSOR_RE = /^([A-Za-z0-9_-]{8,64}):(\d{1,15})$/;

/** Cursor as an opaque string for a query parameter. */
export function encodeAuditCursor(cursor: AuditCursor): string {
  return `${cursor.file}:${cursor.offset}`;
}

/** Parse a cursor produced by `encodeAuditCursor`; null if malformed. */
export function decodeAuditCursor(raw: string): AuditCursor | null {
  const m = CURSOR_RE.exec(raw);
  if (!m) return null;
  const offset = Number(m[2]);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return { file: m[1], offset };
}

function matchesFilters(
  entry: Record<string, unknown>,
  filters: AuditLogFilters
): boolean {
  if (filters.action) {
    const action = typeof entry.action === "string" ? entry.action : "";
    if (!action.toLowerCase().includes(filters.action.toLowerCase())) {
      return false;
    }
  }
  if (filters.outcome && entry.outcome !== filters.outcome) return false;
  if (filters.tenantId && entry.tenantId !== filters.tenantId) return false;
  if (filters.fromMs !== undefined || filters.toMs !== undefined) {
    const ts = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
    if (Number.isNaN(ts)) return false;
    if (filters.fromMs !== undefined && ts < filters.fromMs) return false;
    if (filters.toMs !== undefined && ts > filters.toMs) return false;
  }
  return true;
}

interface OpenLogFile {
  path: string;
  fh: FileHandle;
  size: number;
  identity: string;
}

/**
 * Hash of the file's first line (or of its first few KB when that line is
 * longer). Stable while the file grows, and carried along when the file is
 * renamed by a rotation.
 */
async function fileIdentity(fh: FileHandle, size: number): Promise<string> {
  const len = Math.min(size, IDENTITY_PREFIX_BYTES);
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, 0);
  const head = buf.subarray(0, bytesRead);
  const nl = head.indexOf(0x0a);
  const firstLine = nl === -1 ? head : head.subarray(0, nl);
  return createHash("sha256").update(firstLine).digest("base64url").slice(0, 22);
}

/**
 * Open the live log and every archive that exists, newest first. Each is read
 * through the handle opened here, so a rotation that renames files mid-call
 * cannot swap one file's bytes for another's. Empty files are left out: they
 * hold no entries and have no first line to identify them by.
 */
async function openLogFiles(base: string): Promise<OpenLogFile[]> {
  const files: OpenLogFile[] = [];
  for (let i = 0; i <= MAX_ARCHIVE_INDEX; i++) {
    const path = i === 0 ? base : `${base}.${i}`;
    let fh: FileHandle;
    try {
      fh = await open(path, "r");
    } catch {
      continue;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size === 0) {
        await fh.close();
        continue;
      }
      files.push({ path, fh, size: st.size, identity: await fileIdentity(fh, st.size) });
    } catch {
      await fh.close().catch(() => {});
    }
  }
  return files;
}

function finished(
  restarted: boolean,
  extra: Partial<AuditLogPage> = {}
): AuditLogPage {
  return {
    entries: [],
    nextCursor: null,
    scannedBytes: 0,
    skippedLines: 0,
    done: true,
    reachedFromBound: false,
    oldestScannedTs: null,
    restarted,
    ...extra,
  };
}

export async function readAuditLogPage(opts: {
  /** Where the window ends. Omit/null to start at the newest entry. */
  cursor?: AuditCursor | null;
  maxEntries?: number;
  filters?: AuditLogFilters;
  /** The live log's path; the archives are `<path>.1` and up. For tests. */
  logPath?: string;
}): Promise<AuditLogPage> {
  const maxEntries = Math.min(
    500,
    Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES)
  );
  const filters = opts.filters ?? {};

  const files = await openLogFiles(opts.logPath ?? AUDIT_LOG_PATH);
  try {
    // No log yet — nothing has been audited.
    if (files.length === 0) return finished(false);

    let idx = 0;
    let end = files[0].size;
    let restarted = false;
    const cursor = opts.cursor ?? null;
    if (cursor) {
      const found = files.findIndex((f) => f.identity === cursor.file);
      if (found === -1 || cursor.offset > files[found].size) {
        // The file is gone, or shorter than the cursor (truncated): an offset
        // into it means nothing now. Start again from the newest entry.
        restarted = true;
      } else {
        idx = found;
        end = cursor.offset;
      }
    }
    // A cursor at the very start of a file continues with the next older one.
    while (end <= 0) {
      idx++;
      if (idx >= files.length) return finished(restarted);
      end = files[idx].size;
    }
    const file = files[idx];

    const start = Math.max(0, end - SCAN_WINDOW_BYTES);
    const raw = Buffer.alloc(end - start);
    const { bytesRead } = await file.fh.read(raw, 0, raw.length, start);
    // Fewer bytes than asked only if the file shrank under us; use what came.
    const buf = bytesRead === raw.length ? raw : raw.subarray(0, bytesRead);
    end = start + buf.length;

    const olderFile = files[idx + 1] ?? null;
    // Where the walk goes once this file has been read back to its start.
    const afterThisFile = (): AuditCursor | null =>
      olderFile ? { file: olderFile.identity, offset: olderFile.size } : null;

    // Byte-exact line boundaries: scan the raw buffer for newlines and decode
    // each line individually, so cursors are byte offsets and multi-byte
    // UTF-8 never lands on a window seam.
    let firstLineStart = start;
    let scanFrom = 0;
    if (start > 0) {
      const firstNl = buf.indexOf(0x0a);
      if (firstNl === -1) {
        // No newline in the whole window: a pathologically long line
        // straddles it. Skip the window rather than loop forever; entries are
        // tiny in practice (request bodies are capped at 16 KiB).
        return {
          entries: [],
          nextCursor: { file: file.identity, offset: start },
          scannedBytes: end - start,
          skippedLines: 1,
          done: false,
          reachedFromBound: false,
          oldestScannedTs: null,
          restarted,
        };
      }
      // Everything before the first newline is the tail of a line that
      // starts in the previous (older) window — it is re-read complete next
      // call.
      firstLineStart = start + firstNl + 1;
      scanFrom = firstNl + 1;
    }

    // Collect [byteStart, text] for each complete line in the window.
    const lines: Array<{ offset: number; text: string }> = [];
    let lineStart = scanFrom;
    for (let i = scanFrom; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        lines.push({
          offset: start + lineStart,
          text: buf.toString("utf-8", lineStart, i),
        });
        lineStart = i + 1;
      }
    }
    if (lineStart < buf.length) {
      // Trailing bytes without a newline only happen at true EOF (a write in
      // progress) — treat as a complete line; it re-reads next call otherwise.
      lines.push({
        offset: start + lineStart,
        text: buf.toString("utf-8", lineStart, buf.length),
      });
    }

    const entries: Array<Record<string, unknown>> = [];
    let skippedLines = 0;
    let oldestConsumed = end;
    let oldestScannedTs: string | null = null;
    // The log is appended in (roughly) timestamp order, so once a backwards
    // scan is well past `fromMs` everything further back is older still.
    // Without this, a "last 24 hours" query over a long history walks every
    // window of every archive finding nothing. The walk stops only after a
    // run of FROM_BOUND_STREAK entries that are all clearly older: a single
    // older entry (a clock stepped back, or an entry written out of order)
    // is skipped, not used to cut the scan short.
    let olderStreak = 0;
    let passedFromBound = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      if (entries.length >= maxEntries) break;
      const { offset, text } = lines[i];
      oldestConsumed = offset;
      const trimmed = text.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        skippedLines++;
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        skippedLines++;
        continue;
      }
      const entry = parsed as Record<string, unknown>;
      const ts = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
      if (!Number.isNaN(ts)) oldestScannedTs = entry.ts as string;
      if (filters.fromMs !== undefined && !Number.isNaN(ts)) {
        if (ts < filters.fromMs) {
          if (ts < filters.fromMs - FROM_BOUND_SLACK_MS) {
            olderStreak++;
            if (olderStreak >= FROM_BOUND_STREAK) {
              passedFromBound = true;
              break;
            }
          }
          continue;
        }
        // Back inside the range: whatever older entries came before were
        // out of order, not the end of it.
        olderStreak = 0;
      }
      if (matchesFilters(entry, filters)) entries.push(entry);
    }

    if (passedFromBound) {
      return {
        entries,
        nextCursor: null,
        scannedBytes: end - oldestConsumed,
        skippedLines,
        done: true,
        reachedFromBound: true,
        oldestScannedTs,
        restarted,
      };
    }

    let nextOffset =
      entries.length >= maxEntries ? oldestConsumed : firstLineStart;
    // Progress guard: never return a cursor that doesn't move backwards.
    if (nextOffset >= end) nextOffset = start;

    const nextCursor =
      nextOffset > 0
        ? { file: file.identity, offset: nextOffset }
        : afterThisFile();
    return {
      entries,
      nextCursor,
      scannedBytes: end - Math.max(0, nextOffset),
      skippedLines,
      done: nextCursor === null,
      reachedFromBound: false,
      oldestScannedTs,
      restarted,
    };
  } finally {
    await Promise.all(files.map((f) => f.fh.close().catch(() => {})));
  }
}
