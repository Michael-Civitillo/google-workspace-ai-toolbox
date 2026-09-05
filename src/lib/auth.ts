/**
 * Auth helpers for Open Admin.
 *
 * Uses Web Crypto (globalThis.crypto.subtle) so the same module works in
 * both Edge Middleware and Node API routes — `node:crypto` would crash the
 * edge runtime build.
 */

const COOKIE_NAME = "gws_toolbox_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

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
let warnedSecretFallback = false;

function sessionSecret(): string {
  const explicit = process.env.APP_SESSION_SECRET;
  if (explicit && explicit.length > 0) return explicit;
  const s = process.env.APP_PASSWORD;
  if (!s) throw new Error("APP_PASSWORD is not set");
  // Falling back to APP_PASSWORD as the HMAC key means a captured session
  // cookie can be used to brute-force the login password offline. Warn once so
  // operators know to set a dedicated high-entropy APP_SESSION_SECRET, without
  // breaking the intentional single-env-var deployment path.
  if (!warnedSecretFallback) {
    warnedSecretFallback = true;
    console.warn(
      "[auth] APP_SESSION_SECRET is not set — signing sessions with APP_PASSWORD. " +
        "Set a dedicated high-entropy APP_SESSION_SECRET so a leaked session cookie " +
        "can't be used to brute-force the login password offline."
    );
  }
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

/**
 * base64url without padding, built on btoa/atob so it runs in the edge
 * runtime (no Buffer). Inputs are tiny (session identities, handshake state).
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
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

async function hmacHex(payload: string): Promise<string> {
  const key = await importHmacKey(sessionSecret());
  const sig = await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(payload));
  return bytesToHex(sig);
}

async function hmacMatches(payload: string, sigHex: string): Promise<boolean> {
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
  const actual = hexToBytes(sigHex);
  if (!actual) return false;
  return constantTimeEqual(new Uint8Array(expectedBuf), actual);
}

function notExpired(expiresAt: string): boolean {
  const exp = Number(expiresAt);
  if (!Number.isFinite(exp)) return false;
  return Math.floor(Date.now() / 1000) <= exp;
}

/** How a session was established. */
export type SessionMethod = "password" | "oidc";

/**
 * Who a session belongs to. Password sessions carry no identity beyond the
 * method; single sign-on sessions carry the verified claims from the
 * identity provider so the UI can show who is signed in and audit entries
 * can name an actor.
 */
export interface SessionIdentity {
  method: SessionMethod;
  /** Email asserted by the identity provider (OIDC sessions only). */
  email?: string;
  /** Display name from the identity provider, when it sent one. */
  name?: string;
  /** Stable subject identifier at the identity provider. */
  sub?: string;
}

const TOKEN_V2 = "v2";
// Bound every embedded claim so a hostile or misconfigured identity provider
// can't bloat the cookie past browser limits and lock the operator out.
const MAX_CLAIM_CHARS = 254;

function encodeIdentity(identity: SessionIdentity): string {
  const compact: Record<string, string> = { m: identity.method };
  if (identity.email) compact.e = identity.email.slice(0, MAX_CLAIM_CHARS);
  if (identity.name) compact.n = identity.name.slice(0, MAX_CLAIM_CHARS);
  if (identity.sub) compact.s = identity.sub.slice(0, MAX_CLAIM_CHARS);
  return bytesToBase64Url(TEXT_ENCODER.encode(JSON.stringify(compact)));
}

function decodeIdentity(encoded: string): SessionIdentity | null {
  const bytes = base64UrlToBytes(encoded);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(TEXT_DECODER.decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.m !== "password" && p.m !== "oidc") return null;
  const out: SessionIdentity = { method: p.m };
  if (typeof p.e === "string") out.email = p.e;
  if (typeof p.n === "string") out.name = p.n;
  if (typeof p.s === "string") out.sub = p.s;
  return out;
}

export async function createSessionToken(
  identity: SessionIdentity = { method: "password" }
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const nonce = randomHex(16);
  const payload = `${TOKEN_V2}.${expiresAt}.${nonce}.${encodeIdentity(identity)}`;
  return `${payload}.${await hmacHex(payload)}`;
}

/**
 * Verify a session token and return the identity embedded in it, or null
 * when the token is missing, malformed, tampered with, or expired.
 *
 * Two formats are accepted: the current `v2.<exp>.<nonce>.<identity>.<sig>`
 * and the legacy `<exp>.<nonce>.<sig>` issued before identities were
 * embedded. Honouring the legacy shape means sessions minted by a previous
 * build survive an upgrade instead of every operator being logged out.
 */
export async function readSessionIdentity(
  token: string | undefined | null
): Promise<SessionIdentity | null> {
  if (!token) return null;
  const parts = token.split(".");

  if (parts.length === 5 && parts[0] === TOKEN_V2) {
    const [, expiresAt, nonce, encoded, sigHex] = parts;
    const payload = `${TOKEN_V2}.${expiresAt}.${nonce}.${encoded}`;
    if (!(await hmacMatches(payload, sigHex))) return null;
    if (!notExpired(expiresAt)) return null;
    return decodeIdentity(encoded);
  }

  if (parts.length === 3) {
    const [expiresAt, nonce, sigHex] = parts;
    if (!(await hmacMatches(`${expiresAt}.${nonce}`, sigHex))) return null;
    if (!notExpired(expiresAt)) return null;
    return { method: "password" };
  }

  return null;
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  return (await readSessionIdentity(token)) !== null;
}

/**
 * Sign a short opaque string with the session secret and a TTL. Used for the
 * single sign-on handshake cookie (state, nonce, PKCE verifier), so those
 * values can't be swapped between the redirect out and the callback.
 */
export async function createSignedValue(data: string, ttlSeconds: number): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${expiresAt}.${bytesToBase64Url(TEXT_ENCODER.encode(data))}`;
  return `${payload}.${await hmacHex(payload)}`;
}

/** Inverse of createSignedValue: the original string, or null if invalid/expired. */
export async function readSignedValue(
  token: string | undefined | null
): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [expiresAt, encoded, sigHex] = parts;
  if (!(await hmacMatches(`${expiresAt}.${encoded}`, sigHex))) return null;
  if (!notExpired(expiresAt)) return null;
  const bytes = base64UrlToBytes(encoded);
  if (!bytes) return null;
  return TEXT_DECODER.decode(bytes);
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

/**
 * Cookie attributes shared by every code path that issues a session.
 *
 * `strict` blocks the cookie on any cross-site navigation, top-level or
 * otherwise. Open Admin has no flow that depends on inbound cross-site
 * links (the single sign-on callback lands on a same-origin interstitial
 * before navigating on), so this gives belt-and-braces CSRF protection on top
 * of the Origin/Referer check enforced by the middleware.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
export const SESSION_TTL = SESSION_TTL_SECONDS;
