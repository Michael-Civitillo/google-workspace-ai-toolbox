import { open, stat } from "fs/promises";
import { AUDIT_LOG_PATH } from "./audit";

/**
 * Read-only pagination over the append-only JSON-lines audit log, newest
 * first. The log can grow unbounded, so each call scans one bounded byte
 * window ending at `cursor` (or EOF) and returns a new cursor for the next
 * older window — the same stateless-resumable shape the Drive/sharing scans
 * use, with the client looping.
 *
 * Concurrent appends are safe: the first call snapshots the file size and
 * every later window lies strictly before it, so writers only ever add bytes
 * past the region being read.
 */

const SCAN_WINDOW_BYTES = 512 * 1024;
const DEFAULT_MAX_ENTRIES = 200;

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

export interface AuditLogPage {
  /** Parsed entries in this window that matched the filters, newest first. */
  entries: Array<Record<string, unknown>>;
  /** Byte offset to pass as `cursor` for the next older page; null when done. */
  nextCursor: number | null;
  /** Bytes of the log consumed by this call. */
  scannedBytes: number;
  /** Lines in the window that failed to parse and were skipped. */
  skippedLines: number;
  done: boolean;
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

export async function readAuditLogPage(opts: {
  /** Byte offset the window ends at (exclusive). Omit/null to start at EOF. */
  cursor?: number | null;
  maxEntries?: number;
  filters?: AuditLogFilters;
}): Promise<AuditLogPage> {
  const maxEntries = Math.min(
    500,
    Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES)
  );
  const filters = opts.filters ?? {};

  let size: number;
  try {
    size = (await stat(AUDIT_LOG_PATH)).size;
  } catch {
    // No log yet — nothing has been audited.
    return {
      entries: [],
      nextCursor: null,
      scannedBytes: 0,
      skippedLines: 0,
      done: true,
    };
  }

  // Clamp against truncation/rotation between calls.
  const end = opts.cursor == null ? size : Math.min(opts.cursor, size);
  if (end <= 0) {
    return {
      entries: [],
      nextCursor: null,
      scannedBytes: 0,
      skippedLines: 0,
      done: true,
    };
  }

  const start = Math.max(0, end - SCAN_WINDOW_BYTES);
  const buf = Buffer.alloc(end - start);
  const fh = await open(AUDIT_LOG_PATH, "r");
  try {
    await fh.read(buf, 0, buf.length, start);
  } finally {
    await fh.close();
  }

  // Byte-exact line boundaries: scan the raw buffer for newlines and decode
  // each line individually, so cursors are byte offsets and multi-byte UTF-8
  // never lands on a window seam.
  let firstLineStart = start;
  let scanFrom = 0;
  if (start > 0) {
    const firstNl = buf.indexOf(0x0a);
    if (firstNl === -1) {
      // No newline in the whole window: a pathologically long line straddles
      // it. Skip the window rather than loop forever; entries are tiny in
      // practice (request bodies are capped at 16 KiB).
      return {
        entries: [],
        nextCursor: start === 0 ? null : start,
        scannedBytes: end - start,
        skippedLines: 1,
        done: start === 0,
      };
    }
    // Everything before the first newline is the tail of a line that starts
    // in the previous (older) window — it is re-read complete next call.
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
  // The log is appended in timestamp order, so once a backwards scan meets an
  // entry older than `fromMs` everything further back is older still. Without
  // this, a "last 24 hours" query over a years-old log walks every window to
  // offset 0 finding nothing.
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
    if (filters.fromMs !== undefined) {
      const ts = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
      if (!Number.isNaN(ts) && ts < filters.fromMs) {
        passedFromBound = true;
        break;
      }
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
    };
  }

  let nextCursor =
    entries.length >= maxEntries ? oldestConsumed : firstLineStart;
  // Progress guard: never return a cursor that doesn't move backwards.
  if (nextCursor >= end) nextCursor = start;

  const done = nextCursor <= 0;
  return {
    entries,
    nextCursor: done ? null : nextCursor,
    scannedBytes: end - (done ? 0 : nextCursor),
    skippedLines,
    done,
  };
}
