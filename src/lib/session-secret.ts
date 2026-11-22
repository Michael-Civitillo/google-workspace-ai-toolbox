import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir";

/**
 * The key that signs session cookies and the single sign-on handshake.
 *
 * Resolution order:
 *   1. APP_SESSION_SECRET — an operator-provided high-entropy value.
 *   2. A random 32-byte secret generated on first use and persisted as
 *      `session-secret` (mode 0600) in the data directory, so it survives
 *      restarts and every process on the machine signs with the same key.
 *      A file that exists but holds something unusable (left empty by a full
 *      disk or a crash, or hand-edited) is replaced with a fresh secret.
 *   3. If the file can neither be read nor written (read-only filesystem), a
 *      random secret held in memory, with a warning. Sessions then end when
 *      the server restarts.
 *
 * The login password is never used as the key. It used to be the last
 * resort, and an empty or damaged file silently made it the key on every
 * start; but with single sign-on enabled the public sign-in start route
 * hands a signed cookie to any caller, which would let an attacker crack
 * APP_PASSWORD offline at leisure.
 */
const SECRET_FILE_NAME = "session-secret";
const SECRET_BYTES = 32;
const SECRET_RE = /^[0-9a-f]{64}$/;

// Module state is per bundle (the request gate and the routes are separate
// module graphs in one process), so anything that must be the same for all
// of them lives on globalThis.
const FALLBACK_KEY = "__openAdminSessionSecretFallback";
const g = globalThis as unknown as Record<string, string | undefined>;

let cached: string | null = null;
let warnedFallback = false;

type FileState = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; secret: string };

function readSecretFile(file: string): FileState {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8").trim();
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  return SECRET_RE.test(raw) ? { kind: "ok", secret: raw } : { kind: "invalid" };
}

/** Write `secret` to `file` in full and flush it. Throws on failure. */
function writeFully(file: string, secret: string, flags: "wx"): void {
  const fd = openSync(file, flags, 0o600);
  try {
    const data = Buffer.from(`${secret}\n`);
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function createSecretFile(file: string, secret: string): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // "wx": never overwrite a secret another process created a moment ago.
    writeFully(file, secret, "wx");
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace an unusable secret file. The new secret is written to a temporary
 * file first and renamed over the old one, so a crash can't leave a half
 * written key behind, and the old file is only replaced if it is still
 * unusable (another process may have repaired it in the meantime).
 */
function replaceSecretFile(file: string, secret: string): boolean {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFully(temp, secret, "wx");
    if (readSecretFile(file).kind === "ok") {
      rmSync(temp, { force: true });
      return false;
    }
    renameSync(temp, file);
    return true;
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing more to do.
    }
    return false;
  }
}

export function resolveSessionSecret(): string {
  if (cached) return cached;

  const explicit = process.env.APP_SESSION_SECRET;
  if (explicit && explicit.length > 0) {
    cached = explicit;
    return cached;
  }

  const file = dataPath(SECRET_FILE_NAME);
  const existing = readSecretFile(file);
  if (existing.kind === "ok") {
    // Re-tighten a file that may have been created under a loose umask by an
    // older build or copied by hand.
    try {
      if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600);
    } catch {}
    cached = existing.secret;
    return cached;
  }

  const fresh = randomBytes(SECRET_BYTES).toString("hex");
  const wrote =
    existing.kind === "missing" ? createSecretFile(file, fresh) : replaceSecretFile(file, fresh);
  if (wrote) {
    cached = fresh;
    return cached;
  }
  // Lost a race with another process, or that process repaired the file
  // first: use what is on disk now.
  const now = readSecretFile(file);
  if (now.kind === "ok") {
    cached = now.secret;
    return cached;
  }

  if (!g[FALLBACK_KEY]) g[FALLBACK_KEY] = randomBytes(SECRET_BYTES).toString("hex");
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(
      `[auth] could not read or write a usable session secret at ${file} and ` +
        "APP_SESSION_SECRET is not set — using a temporary key, so everyone is signed " +
        "out when the server restarts. Set APP_SESSION_SECRET or make the data directory writable."
    );
  }
  cached = g[FALLBACK_KEY] as string;
  return cached;
}

/** Forget the resolved secret. For tests. */
export function resetSessionSecretForTests(): void {
  cached = null;
  warnedFallback = false;
  delete g[FALLBACK_KEY];
}
