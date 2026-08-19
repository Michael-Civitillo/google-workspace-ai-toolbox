/**
 * Auth helpers for the toolbox.
 *
 * Uses Web Crypto (globalThis.crypto.subtle) so the same module works in
 * both Edge Middleware and Node API routes — `node:crypto` would crash the
 * edge runtime build. For the same reason this module must never read
 * app-config.json: config-aware decisions (e.g. whether password login is
 * currently allowed) live in app-config.ts and run only in Node routes.
 */

const COOKIE_NAME = "gws_toolbox_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const TEXT_ENCODER = new TextEncoder();

/**
 * The app refuses to serve anything without a signing secret configured.
 * APP_PASSWORD covers the classic password-gate deployment;
 * APP_SESSION_SECRET alone supports SSO-only deployments with no shared
 * password at all.
 */
export function authConfigured(): boolean {
  return Boolean(process.env.APP_PASSWORD || process.env.APP_SESSION_SECRET);
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
  if (!s) throw new Error("Neither APP_SESSION_SECRET nor APP_PASSWORD is set");
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

// Base64url without Buffer so the module stays Edge-safe. Payloads are tiny
// (a few hundred bytes), so the char-by-char paths are fine.
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(b64);
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

/**
 * Sign an arbitrary small JSON payload into a compact
 * `base64url(json).hexSig` token. Used for session cookies and the transient
 * OIDC login-state cookie — both need tamper-proofing with the same key.
 */
export async function signPayload(
  payload: Record<string, unknown>
): Promise<string> {
  const body = bytesToBase64Url(TEXT_ENCODER.encode(JSON.stringify(payload)));
  const key = await importHmacKey(sessionSecret());
  const sig = await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(body));
  return `${body}.${bytesToHex(sig)}`;
}

/**
 * Verify a `signPayload` token's signature and parse its payload. Returns
 * null for anything malformed or tampered. Expiry is the caller's concern —
 * different payload kinds carry different lifetime fields.
 */
export async function verifySignedPayload(
  token: string | undefined | null
): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sigHex] = parts;
  let key: CryptoKey;
  try {
    key = await importHmacKey(sessionSecret());
  } catch {
    return null;
  }
  const expectedBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    TEXT_ENCODER.encode(body)
  );
  const actual = hexToBytes(sigHex);
  if (!actual) return null;
  if (!constantTimeEqual(new Uint8Array(expectedBuf), actual)) return null;
  const bytes = base64UrlToBytes(body);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type LoginMethod = "password" | "sso";

export interface SessionIdentity {
  /** Who logged in — the SSO email, or null for the shared password gate. */
  sub: string | null;
  method: LoginMethod;
}

export interface SessionPayload extends SessionIdentity {
  exp: number;
  nonce: string;
}

export async function createSessionToken(
  identity: SessionIdentity
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return signPayload({
    exp,
    nonce: randomHex(16),
    sub: identity.sub,
    method: identity.method,
  });
}

/**
 * Verify a session cookie. Returns the session's payload (identity included)
 * when valid, null otherwise — callers that only care about validity can use
 * it as a boolean. Tokens from before the identity-carrying format simply
 * fail verification, forcing one re-login.
 */
export async function verifySessionToken(
  token: string | undefined | null
): Promise<SessionPayload | null> {
  const payload = await verifySignedPayload(token);
  if (!payload) return null;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp)) return null;
  if (Math.floor(Date.now() / 1000) > exp) return null;
  if (typeof payload.nonce !== "string") return null;
  const method: LoginMethod =
    payload.method === "sso" ? "sso" : "password";
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  return { exp, nonce: payload.nonce, sub, method };
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
