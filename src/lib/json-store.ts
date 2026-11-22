import { randomBytes } from "crypto";
import {
  readFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  openSync,
  fchmodSync,
  writeSync,
  fsyncSync,
  closeSync,
  mkdirSync,
  statSync,
} from "fs";
import path from "path";

/**
 * Shared machinery for the toolbox's small on-disk JSON stores
 * (tenants.json, app-config.json): corruption-safe reads, atomic
 * tmp-file + fsync + rename writes, and a per-file in-process write mutex.
 *
 * Extracted from the tenant store so every store gets identical durability
 * semantics instead of each file growing its own subtly different copy.
 */

/**
 * Move an on-disk store aside under a timestamped name so a subsequent write
 * can't silently overwrite it. Used only when the file is genuinely unusable
 * (empty or unparseable) — never for a transient read error.
 */
function quarantineFile(storePath: string): void {
  try {
    renameSync(storePath, `${storePath}.corrupt-${Date.now()}`);
  } catch {
    // If we can't even move it, fall through — we still avoid throwing into the
    // request handler for the corruption case.
  }
}

/**
 * Read a JSON store file as a plain object.
 *
 * Returns `null` for every "start from an empty store" case: the file doesn't
 * exist, is empty, or holds corrupt/non-object JSON (the latter two are
 * quarantined first so the evidence survives). Throws only on transient read
 * errors (EBUSY/EMFILE, antivirus locks, fd exhaustion) — surfacing those
 * instead of quarantining keeps a healthy store intact across a blip, and a
 * read-modify-write under the lock aborts rather than persisting an empty
 * store over the real config.
 */
export function readJsonObjectFile(
  storePath: string
): Record<string, unknown> | null {
  if (!existsSync(storePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(storePath, "utf-8");
  } catch (e) {
    // The existsSync above raced a delete (external cleanup or a concurrent
    // quarantine rename): a missing file is the same benign "no store yet"
    // state as the guard at the top, not an error.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new Error(
      `Failed to read store at ${storePath}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  if (!raw.trim()) {
    // Existing-but-empty file: preserve it before returning an empty store so a
    // subsequent write can't overwrite a (possibly externally truncated) config
    // with no trace. After the rename the path is gone, so this happens once.
    quarantineFile(storePath);
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    // Parseable but not an object (a bare scalar, array, or null) is just as
    // corrupt as unparseable content — quarantine it too, or the next write
    // would silently overwrite the evidence with an empty store.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      quarantineFile(storePath);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    quarantineFile(storePath);
    return null;
  }
}

/**
 * Write a text file atomically: write to a sibling tmp file (0600), fsync it,
 * then rename over the real path. Guarantees a crash mid-write never leaves a
 * half-written OR zero-length file on disk. The explicit fsync before rename
 * matters: on ext4/xfs a rename can become durable before the file's data
 * blocks, so a crash could otherwise leave an empty file that a later read
 * treats as "no store" and the next write makes permanent. Missing parent
 * directories are created (0700).
 */
export async function writeTextFileAtomic(
  storePath: string,
  text: string
): Promise<void> {
  mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  // A fresh, exclusively created temp file every time ("wx" plus a random
  // suffix): a `.tmp` planted in advance by another local user would
  // otherwise keep its own — possibly world-readable — mode through the
  // rename. fchmod pins 0600 regardless of the process umask.
  const tmpPath = `${storePath}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    // Every byte, or nothing: writeSync may write less than asked (a nearly
    // full disk), and renaming a cut-off file over a good one would replace
    // the store with something that no longer parses.
    const data = Buffer.from(text, "utf-8");
    let written = 0;
    while (written < data.length) {
      const n = writeSync(fd, data, written, data.length - written);
      if (n <= 0) throw new Error(`Could not write ${storePath}: the disk took no more data`);
      written += n;
    }
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort: the good file is untouched either way.
    }
    throw e;
  }
  closeSync(fd);

  // On Windows the rename can transiently fail with EPERM/EBUSY if
  // antivirus / Windows Search Indexer briefly holds the destination
  // file open. Retry a couple of times with tiny backoffs before giving up.
  const MAX_ATTEMPTS = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      renameSync(tmpPath, storePath);
      // Best-effort: fsync the containing directory so the rename itself is
      // durable. Directory fsync isn't supported on Windows (EPERM/EISDIR) — a
      // no-op there, so swallow failures rather than fail an otherwise-good write.
      try {
        const dirFd = openSync(path.dirname(storePath), "r");
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch {
        // Directory fsync unsupported on this platform — ignore.
      }
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      const transient =
        code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt === MAX_ATTEMPTS) break;
      // Yield with a real timer instead of spinning — withFileLock() already
      // serialises writers, so awaiting here never interleaves a concurrent
      // read-modify-write, and it keeps the event loop free.
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
  try {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  } catch {}
  throw lastError;
}

/** JSON convenience wrapper over {@link writeTextFileAtomic}. */
export async function writeJsonFileAtomic(
  storePath: string,
  data: unknown
): Promise<void> {
  parsedCache.delete(storePath);
  try {
    await writeTextFileAtomic(storePath, JSON.stringify(data, null, 2));
  } finally {
    parsedCache.delete(storePath);
  }
}

// ---------------------------------------------------------------------------
// Parsed stores, kept between requests
// ---------------------------------------------------------------------------

/**
 * tenants.json and sso.json used to be read and parsed on every API call.
 * The parsed object is now kept while the file on disk looks unchanged (same
 * size, modification time and inode), and for a few seconds at most, so an
 * edit that keeps both still shows up promptly. Writes through this module
 * drop the entry. Every caller gets its own copy, so changing what it was
 * handed can't change what the next request sees.
 */
const PARSED_CACHE_MAX_AGE_MS = 5_000;
const parsedCache = new Map<
  string,
  { at: number; mtimeMs: number; size: number; ino: number; value: Record<string, unknown> | null }
>();

export function readJsonObjectFileCached(storePath: string): Record<string, unknown> | null {
  let stat: { mtimeMs: number; size: number; ino: number } | null = null;
  try {
    const st = statSync(storePath);
    stat = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
  } catch {
    stat = null;
  }
  const hit = parsedCache.get(storePath);
  if (
    stat &&
    hit &&
    Date.now() - hit.at < PARSED_CACHE_MAX_AGE_MS &&
    hit.mtimeMs === stat.mtimeMs &&
    hit.size === stat.size &&
    hit.ino === stat.ino
  ) {
    return hit.value === null ? null : structuredClone(hit.value);
  }
  const value = readJsonObjectFile(storePath);
  if (stat) {
    parsedCache.set(storePath, { at: Date.now(), ...stat, value });
  } else {
    parsedCache.delete(storePath);
  }
  return value === null ? null : structuredClone(value);
}

/**
 * Per-path single-process write mutex. All read-modify-write sequences on a
 * given store serialise through this so concurrent API requests can't lose
 * each other's changes.
 */
const locks = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(
  storePath: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = locks.get(storePath) ?? Promise.resolve();
  let release: () => void = () => {};
  locks.set(
    storePath,
    new Promise<void>((res) => {
      release = res;
    })
  );
  try {
    await previous;
    // `await` (not a bare `return fn()`) so the lock is held until the async
    // critical section fully settles. Without it the `finally` below would run
    // release() the moment fn() returns its pending promise — freeing the lock
    // mid-write and letting a concurrent writer read stale state and clobber
    // the shared temp file.
    return await fn();
  } finally {
    release();
  }
}
