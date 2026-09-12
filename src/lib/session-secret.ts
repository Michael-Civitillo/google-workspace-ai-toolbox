import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
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
 *   3. If that file can neither be read nor written (read-only filesystem),
 *      the login password — the historical behaviour, with a loud warning,
 *      because a signed value is then an offline brute-force sample.
 *
 * The login password is deliberately not the default: with single sign-on
 * enabled the public sign-in start route hands a signed cookie to any caller,
 * which would let an attacker crack APP_PASSWORD offline at leisure.
 */
const SECRET_FILE_NAME = "session-secret";
const SECRET_BYTES = 32;

let cached: string | null = null;
let warnedFallback = false;

function readSecretFile(file: string): string | null {
  try {
    const raw = readFileSync(file, "utf-8").trim();
    return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeSecretFile(file: string, secret: string): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // "wx": never overwrite a secret another process created a moment ago.
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, `${secret}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
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
  if (existing) {
    // Re-tighten a file that may have been created under a loose umask by an
    // older build or copied by hand.
    try {
      if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600);
    } catch {}
    cached = existing;
    return cached;
  }

  const fresh = randomBytes(SECRET_BYTES).toString("hex");
  if (writeSecretFile(file, fresh)) {
    cached = fresh;
    return cached;
  }
  // Lost the race with another process, or the file exists but held
  // something unusable: read once more before giving up on the file.
  const raced = readSecretFile(file);
  if (raced) {
    cached = raced;
    return cached;
  }

  const password = process.env.APP_PASSWORD;
  if (!password) throw new Error("APP_PASSWORD is not set");
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(
      `[auth] could not persist a session secret at ${file} and APP_SESSION_SECRET is not set — ` +
        "signing sessions with APP_PASSWORD. Set APP_SESSION_SECRET or make the data directory writable."
    );
  }
  cached = password;
  return cached;
}
