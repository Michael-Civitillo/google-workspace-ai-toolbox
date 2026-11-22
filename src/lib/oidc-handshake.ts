import { createSignedValue, readSignedValue, requestIsSecure } from "./auth";
import type { OidcHandshake } from "./oidc";
import { safeNextPath } from "./safe-next";

export { safeNextPath };

/**
 * The single sign-on handshake cookie.
 *
 * `/api/auth/oidc/start` generates the state, nonce and PKCE verifier for one
 * sign-in attempt and parks them here, signed with the session secret, so the
 * callback can prove the response belongs to a request this server started.
 * It is scoped to the OIDC routes, short-lived, and SameSite=Lax (not Strict)
 * because the callback is a top-level navigation arriving from the provider.
 *
 * No `__Host-` prefix, for the same reason as the session cookie (see auth.ts):
 * the prefix demands Secure, which browsers refuse over the plain http this
 * tool is routinely reached on — and it also demands Path=/, which would widen
 * this cookie beyond the sign-in routes it belongs to.
 */
export const HANDSHAKE_COOKIE_NAME = "gws_toolbox_oidc";
export const HANDSHAKE_TTL_SECONDS = 10 * 60;

/** Pass the request wherever one is at hand: `Secure` follows its scheme. */
export function handshakeCookieOptions(req?: Request) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: requestIsSecure(req),
    path: "/api/auth/oidc",
    maxAge: HANDSHAKE_TTL_SECONDS,
  };
}

export async function serializeHandshake(h: OidcHandshake): Promise<string> {
  return createSignedValue(JSON.stringify(h), HANDSHAKE_TTL_SECONDS);
}

export async function parseHandshake(
  token: string | undefined | null
): Promise<OidcHandshake | null> {
  const raw = await readSignedValue(token);
  if (!raw) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !p ||
    p.v !== 1 ||
    typeof p.state !== "string" ||
    typeof p.nonce !== "string" ||
    typeof p.verifier !== "string" ||
    (p.mode !== "login" && p.mode !== "test") ||
    typeof p.next !== "string"
  ) {
    return null;
  }
  const handshake: OidcHandshake = {
    v: 1,
    state: p.state,
    nonce: p.nonce,
    verifier: p.verifier,
    mode: p.mode,
    next: safeNextPath(p.next),
  };
  if (typeof p.actor === "string" && p.actor) {
    handshake.actor = p.actor.slice(0, 254);
  }
  return handshake;
}

/**
 * Mark a handshake as used. True the first time its `state` is seen, false
 * after that. The cookie is cleared after every callback, but a copy of it
 * stayed valid for its full ten minutes, so the same handshake could be
 * replayed against the callback again and again. Kept on globalThis and
 * pruned as entries expire; bounded so a flood can't exhaust memory.
 */
const USED_KEY = "__openAdminUsedHandshakes";
const USED_MAX = 50_000;

export function consumeHandshake(state: string, now: number = Date.now()): boolean {
  const g = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  const used = (g[USED_KEY] ??= new Map<string, number>());
  for (const [key, expiresAt] of used) {
    if (expiresAt > now) break; // insertion order is expiry order
    used.delete(key);
  }
  if (used.has(state)) return false;
  used.set(state, now + HANDSHAKE_TTL_SECONDS * 1000);
  while (used.size > USED_MAX) {
    const oldest = used.keys().next().value;
    if (oldest === undefined) break;
    used.delete(oldest);
  }
  return true;
}
