import { NextResponse, type NextRequest } from "next/server";
import { rateLimit, clientKey } from "./rate-limit";
import { identityFromRequest } from "./session";

/**
 * Shared spend limit for the Gemini-backed routes (user audit, security
 * digest, command parsing).
 *
 * ONE budget for all three, not one each: the bill is charged to a single API
 * key, so a script that hops between the endpoints must not get three times
 * the allowance. 30 generations per 10 minutes is far more than an operator
 * can consume by hand — each report takes tens of seconds to produce and
 * longer to read — while a runaway loop or a stuck retry stops costing money
 * within one window instead of running all night.
 */
const AI_CALL_LIMIT = 30;
const AI_WINDOW_MS = 10 * 60 * 1000;

/**
 * Charge one AI generation to the caller's budget and return the 429 to answer
 * with when it is spent, or null to proceed.
 *
 * Keyed by the single sign-on identity when there is one, so one operator's
 * loop can't spend everyone's allowance and a rotated `X-Forwarded-For` can't
 * shed the charge. Shared-password sessions have no distinguishing identity,
 * so they share one bucket — the same aggregate-throttle failure mode
 * `clientKey` already falls back to, and the safer one for a shared secret.
 */
export async function chargeAiBudget(
  req: NextRequest
): Promise<NextResponse | null> {
  const identity = await identityFromRequest(req);
  let who: string;
  if (identity?.method === "oidc") {
    who = `sso:${identity.sub || identity.email || "unknown"}`;
  } else if (identity) {
    who = "password-session";
  } else {
    who = `ip:${clientKey(req)}`;
  }

  const gate = rateLimit(`ai:${who}`, AI_CALL_LIMIT, AI_WINDOW_MS);
  if (gate.allowed) return null;

  return NextResponse.json(
    {
      success: false,
      error:
        `AI request limit reached (${AI_CALL_LIMIT} per ` +
        `${AI_WINDOW_MS / 60_000} minutes, shared across all AI features). ` +
        `Try again in ${gate.retryAfter}s.`,
    },
    { status: 429, headers: { "Retry-After": String(gate.retryAfter) } }
  );
}
