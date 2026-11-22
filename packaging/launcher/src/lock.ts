import fs from "node:fs";
import crypto from "node:crypto";
import { errorCode, TRANSIENT_CODES, writeAllSync } from "./fsutil.ts";
import { isProcessAlive } from "./instance.ts";

/**
 * Exclusive lock files, so two launches close together take turns instead of
 * unpacking into, or deleting, the same folder at the same time.
 *
 * A lock is a file created with "wx", which exactly one process can do. It
 * names its owner's process id. A lock whose process is gone (the window was
 * closed, the machine lost power) is stale and is taken over; so is one older
 * than `staleAfterMs`, which covers a process id that was reused after a crash.
 */

export interface LockOwner {
  pid: number;
  nonce: string;
  /** Milliseconds since the epoch. */
  startedAt: number;
}

export interface LockOptions {
  /** A lock older than this counts as left over, whatever its process id. */
  staleAfterMs?: number;
  /** Stop waiting after this long and throw LockTimeoutError. */
  waitMs?: number;
  pollMs?: number;
  /** Called once, the first time the lock turns out to be held by someone else. */
  onWait?: (owner: LockOwner | null) => void;
  /** Injectable for tests. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export interface HeldLock {
  /** Remove the lock if it is still this one. Safe to call twice. */
  release(): void;
}

export class LockTimeoutError extends Error {
  owner: LockOwner | null;
  constructor(file: string, owner: LockOwner | null) {
    super(`${file} is still held${owner ? ` by process ${owner.pid}` : ""}`);
    this.name = "LockTimeoutError";
    this.owner = owner;
  }
}

/**
 * A lock file nobody has finished writing yet is left alone this long before
 * it is taken for the remains of a crash between creating and writing it.
 */
const UNREADABLE_GRACE_MS = 5000;

const DEFAULTS = {
  staleAfterMs: 10 * 60_000,
  waitMs: 3 * 60_000,
  pollMs: 200,
};

interface Observed {
  raw: string;
  owner: LockOwner | null;
  mtimeMs: number;
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (
      typeof value.pid === "number" &&
      typeof value.nonce === "string" &&
      typeof value.startedAt === "number"
    ) {
      return { pid: value.pid, nonce: value.nonce, startedAt: value.startedAt };
    }
  } catch {
    // Not written yet, or not ours.
  }
  return null;
}

/** The lock's current content, or null when there is no lock file. */
function observe(file: string, now: number): Observed | null {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const mtimeMs = fs.statSync(file).mtimeMs;
    return { raw, owner: parseOwner(raw), mtimeMs };
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    // Unreadable for a moment (Windows antivirus): treat it as held, by nobody known.
    return { raw: "", owner: null, mtimeMs: now };
  }
}

/** Locks this process holds right now, by nonce. */
const heldHere = new Set<string>();

function isStale(
  seen: Observed,
  now: number,
  staleAfterMs: number,
  isAlive: (pid: number) => boolean
): boolean {
  if (!seen.owner) return now - seen.mtimeMs > UNREADABLE_GRACE_MS;
  // Our own id but not a lock we hold: left by an earlier process with the
  // same id, which is necessarily gone.
  if (seen.owner.pid === process.pid) return !heldHere.has(seen.owner.nonce);
  if (!isAlive(seen.owner.pid)) return true;
  return now - seen.owner.startedAt > staleAfterMs;
}

/**
 * Take a stale lock out of the way without removing a fresh one that replaced
 * it in the meantime: move it aside under a unique name (which only one
 * process can do), then check what was moved.
 */
function breakStale(file: string, seen: Observed): void {
  const aside = `${file}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return; // Gone already, or locked for a moment: look again.
  }
  let moved = "";
  try {
    moved = fs.readFileSync(aside, "utf-8");
  } catch {
    // Treat as the stale one.
    moved = seen.raw;
  }
  if (moved !== seen.raw && !fs.existsSync(file)) {
    // Someone else's fresh lock: put it back.
    try {
      fs.renameSync(aside, file);
      return;
    } catch {
      // Fall through and drop it; whoever held it will find it missing on release.
    }
  }
  try {
    fs.rmSync(aside, { force: true });
  } catch {
    // A leftover with a unique name harms nothing.
  }
}

type CreateResult = { ok: true } | { ok: false; error: unknown | null };

/** Create the lock. `error` is null when it simply exists already. */
function tryCreate(file: string, owner: LockOwner): CreateResult {
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    const code = errorCode(e);
    if (code === "EEXIST") return { ok: false, error: null };
    // Windows refuses to create a file whose previous copy is still being
    // deleted; anything else transient is worth another try too.
    if (TRANSIENT_CODES.has(code)) return { ok: false, error: e };
    throw e;
  }
  try {
    writeAllSync(fd, Buffer.from(JSON.stringify(owner), "utf-8"));
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true };
}

function holding(file: string, owner: LockOwner): HeldLock {
  let released = false;
  heldHere.add(owner.nonce);
  const release = (): void => {
    if (released) return;
    released = true;
    heldHere.delete(owner.nonce);
    process.off("exit", release);
    try {
      if (parseOwner(fs.readFileSync(file, "utf-8"))?.nonce === owner.nonce) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Already gone.
    }
  };
  // However this process ends, it must not leave a lock with a live-looking
  // owner behind for long; this covers every exit that runs JavaScript.
  process.on("exit", release);
  return { release };
}

/**
 * Wait for, and take, the lock in `file`. Resolves once this process holds
 * it; rejects with LockTimeoutError if another live process keeps holding it
 * for longer than `waitMs`.
 */
export async function acquireLock(file: string, options: LockOptions = {}): Promise<HeldLock> {
  const staleAfterMs = options.staleAfterMs ?? DEFAULTS.staleAfterMs;
  const waitMs = options.waitMs ?? DEFAULTS.waitMs;
  const pollMs = options.pollMs ?? DEFAULTS.pollMs;
  const isAlive = options.isAlive ?? isProcessAlive;
  const now = options.now ?? Date.now;

  const owner: LockOwner = {
    pid: process.pid,
    nonce: crypto.randomBytes(16).toString("hex"),
    startedAt: now(),
  };
  const giveUpAt = now() + waitMs;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let announced = false;

  for (;;) {
    owner.startedAt = now();
    const created = tryCreate(file, owner);
    if (created.ok) return holding(file, owner);

    const seen = observe(file, now());
    if (seen === null) {
      // No lock, yet it could not be created: a folder that refuses new
      // files for now (or for good). Retry until the deadline, then say why.
      if (created.error !== null && now() >= giveUpAt) throw created.error;
      await pause(created.error !== null ? pollMs : 1);
      continue;
    }
    if (isStale(seen, now(), staleAfterMs, isAlive)) {
      breakStale(file, seen);
      // Give a competitor that broke it first a moment to write its own.
      await pause(10);
      if (now() >= giveUpAt) throw new LockTimeoutError(file, seen.owner);
      continue;
    }
    if (!announced) {
      announced = true;
      options.onWait?.(seen.owner);
    }
    if (now() >= giveUpAt) throw new LockTimeoutError(file, seen.owner);
    await pause(pollMs);
  }
}
