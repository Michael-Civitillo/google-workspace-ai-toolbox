import type { NextRequest } from "next/server";
import {
  readSessionIdentity,
  SESSION_COOKIE_NAME,
  type SessionIdentity,
} from "./auth";

/** The identity behind a request's session cookie, or null when unauthenticated. */
export async function identityFromRequest(
  req: NextRequest
): Promise<SessionIdentity | null> {
  return readSessionIdentity(req.cookies.get(SESSION_COOKIE_NAME)?.value);
}

/**
 * A short label for audit entries: the single sign-on email when there is
 * one, otherwise a marker for the shared-password session.
 */
export function describeActor(identity: SessionIdentity | null): string {
  if (identity?.method === "oidc" && identity.email) return identity.email;
  return "password-session";
}

/** The audit actor for a request, in one call. */
export async function actorFromRequest(req: NextRequest): Promise<string> {
  return describeActor(await identityFromRequest(req));
}
