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

function sessionSecret(): string {
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
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(v)) return null;
    out[i] = v;
  }
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
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

export function passwordMatches(input: string): boolean {
  const expected = process.env.APP_PASSWORD || "";
  if (!expected) return false;
  const a = TEXT_ENCODER.encode(expected);
  const b = TEXT_ENCODER.encode(input || "");
  if (a.length !== b.length) return false;
  return constantTimeEqual(a, b);
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
export const SESSION_TTL = SESSION_TTL_SECONDS;
