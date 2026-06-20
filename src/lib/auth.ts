/**
 * Auth helpers for the toolbox.
 *
 * Uses Web Crypto (globalThis.crypto.subtle) so the same module works in
 * both Edge Middleware and Node API routes — `node:crypto` would crash the
 * edge runtime build.
 */

const COOKIE_NAME = "gws_toolbox_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const TEXT_ENCODER = new TextEncoder();

export function authConfigured(): boolean {
  return Boolean(process.env.APP_PASSWORD && process.env.APP_PASSWORD.length > 0);
}

/**
 * Secret used to sign session tokens. Prefer a dedicated, high-entropy
 * APP_SESSION_SECRET: it decouples the token signature from the login
 * password, so a stolen session cookie can no longer be used to brute-force
 * APP_PASSWORD offline. Falls back to APP_PASSWORD when no session secret is
 * set, preserving the single-env-var deployment model.
 */
function sessionSecret(): string {
  const explicit = process.env.APP_SESSION_SECRET;
  if (explicit && explicit.length > 0) return explicit;
  const s = process.env.APP_PASSWORD;
  if (!s) throw new Error("APP_PASSWORD is not set");
  return s;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function bytesToHex(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < u.length; i++) {
    out += u[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  // Reject anything that isn't pure hex up front: parseInt would silently
  // accept a half-valid pair (e.g. "1g" -> 0x01) and yield wrong bytes.
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

/**
 * Constant-time string compare. Length differences leak (we early-exit) but
 * the operator-visible string they're confirming is already known to them,
 * so length disclosure is not a meaningful side channel.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const ea = TEXT_ENCODER.encode(a);
  const eb = TEXT_ENCODER.encode(b);
  return constantTimeEqual(ea, eb);
}

function randomHex(byteCount: number): string {
  const buf = new Uint8Array(byteCount);
  crypto.getRandomValues(buf);
  return bytesToHex(buf.buffer);
}

export async function createSessionToken(): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const nonce = randomHex(16);
  const payload = `${expiresAt}.${nonce}`;
  const key = await importHmacKey(sessionSecret());
  const sig = await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(payload));
  return `${payload}.${bytesToHex(sig)}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expiresAt, nonce, sigHex] = parts;
  const payload = `${expiresAt}.${nonce}`;
  let key: CryptoKey;
  try {
    key = await importHmacKey(sessionSecret());
  } catch {
    return false;
  }
  const expectedBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    TEXT_ENCODER.encode(payload)
  );
  const expected = new Uint8Array(expectedBuf);
  const actual = hexToBytes(sigHex);
  if (!actual) return false;
  if (!constantTimeEqual(expected, actual)) return false;
  const exp = Number(expiresAt);
  if (!Number.isFinite(exp)) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  return true;
}

export async function passwordMatches(input: string): Promise<boolean> {
  const expected = process.env.APP_PASSWORD || "";
  if (!expected) return false;
  // Compare SHA-256 digests rather than the raw bytes: digests are always the
  // same length, so the comparison no longer short-circuits on a length
  // mismatch and the candidate password's length doesn't leak via timing.
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(expected)),
    crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(input || "")),
  ]);
  return constantTimeEqual(new Uint8Array(a), new Uint8Array(b));
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
export const SESSION_TTL = SESSION_TTL_SECONDS;
