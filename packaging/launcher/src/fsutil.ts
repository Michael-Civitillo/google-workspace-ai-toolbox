import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * File-system helpers shared by the launcher's own files (launcher.json,
 * launcher.lock, the unpacked application).
 */

/** Block the current thread without spinning the CPU. */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The errors Windows antivirus, backup and indexing tools cause by holding a
 * file or folder open for a moment after it was written.
 */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "EBUSY",
  "EPERM",
  "EACCES",
  "ENOTEMPTY",
]);

export function errorCode(e: unknown): string {
  return (e as NodeJS.ErrnoException | null)?.code ?? "";
}

export interface RetryOptions {
  /** Give up once this much time has been spent waiting. */
  totalMs: number;
  /** First pause; each later one doubles, up to maxDelayMs. */
  firstDelayMs?: number;
  maxDelayMs?: number;
  codes?: ReadonlySet<string>;
  /** Injectable for tests. */
  sleep?: (ms: number) => void;
}

/**
 * Run `operation`, retrying while it fails with a transient error, for up to
 * `totalMs` of waiting in all. The last error is rethrown.
 */
export function retrySync<T>(operation: () => T, options: RetryOptions): T {
  const codes = options.codes ?? TRANSIENT_CODES;
  const sleep = options.sleep ?? sleepSync;
  let delay = options.firstDelayMs ?? 50;
  const maxDelay = options.maxDelayMs ?? 2000;
  let waited = 0;
  for (;;) {
    try {
      return operation();
    } catch (e) {
      if (!codes.has(errorCode(e)) || waited >= options.totalMs) throw e;
      const pause = Math.min(delay, maxDelay, options.totalMs - waited);
      sleep(pause);
      waited += pause;
      delay *= 2;
    }
  }
}

/** Write all of `data`; writeSync may write less than it was given. */
export function writeAllSync(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    offset += fs.writeSync(fd, data, offset, data.length - offset);
  }
}

/** Flush a directory entry to disk. Not possible on Windows; best effort. */
export function fsyncDirSync(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Windows cannot open a directory for this; nothing to do.
  }
}

/** True when a POSIX mode lets nobody but the owner read or write. */
export function isOwnerOnly(mode: number): boolean {
  return (mode & 0o077) === 0;
}

/**
 * Replace `file` with `text` so that a crash at any point leaves either the old
 * file or the new one, never a mix, and so that the new file is readable by
 * its owner only.
 *
 * The same discipline as the app's own stores (src/lib/json-store.ts): a fresh
 * temporary name nobody can predict, created exclusively ("wx") so that a file
 * planted under that name can't lend the result its own owner or mode, its
 * mode pinned with fchmod regardless of the umask, every byte written and
 * fsynced before the rename, and the rename retried through the brief locks
 * Windows antivirus takes. The temporary file is removed on any failure,
 * because it may hold a password.
 *
 * Returns false when the file ended up readable by others because the file
 * system has no POSIX modes to set (a FAT-formatted USB stick on Linux or
 * macOS, say); the write itself still happened.
 */
export function writeFileAtomicSync(
  file: string,
  text: string,
  options: { mode?: number; renameRetryMs?: number } = {}
): boolean {
  const mode = options.mode ?? 0o600;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", mode);
  let ownerOnly = true;
  let closed = false;
  let renamed = false;
  try {
    try {
      fs.fchmodSync(fd, mode);
    } catch {
      // Checked below instead: what matters is the mode the file has.
    }
    if (process.platform !== "win32") ownerOnly = isOwnerOnly(fs.fstatSync(fd).mode);
    writeAllSync(fd, Buffer.from(text, "utf-8"));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    closed = true;
    retrySync(() => fs.renameSync(tmp, file), { totalMs: options.renameRetryMs ?? 3000 });
    renamed = true;
  } finally {
    if (!closed) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing to release.
      }
    }
    if (!renamed) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Nothing more can be done; the name is random and unlikely to clash.
      }
    }
  }
  fsyncDirSync(dir);
  return ownerOnly;
}
