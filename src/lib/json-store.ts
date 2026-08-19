import {
  readFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
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
 * Write a JSON store atomically: serialise to a sibling tmp file (0600),
 * fsync it, then rename over the real path. Guarantees a crash mid-write never
 * leaves a half-written OR zero-length store on disk. The explicit fsync
 * before rename matters: on ext4/xfs a rename can become durable before the
 * file's data blocks, so a crash could otherwise leave an empty file that a
 * later read treats as "no store" and the next write makes permanent.
 */
export async function writeJsonFileAtomic(
  storePath: string,
  data: unknown
): Promise<void> {
  const tmpPath = `${storePath}.tmp`;
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

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
