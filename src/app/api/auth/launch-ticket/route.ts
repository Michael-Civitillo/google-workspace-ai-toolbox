import { NextRequest, NextResponse } from "next/server";
import { authConfigured, passwordMatches } from "@/lib/auth";
import { issueLaunchTicket, launchTicketsSupported } from "@/lib/launch-tickets";
import { rateLimit, peekRateLimit, clearRateLimit, clientKey } from "@/lib/rate-limit";
import { passwordLoginEnabled, readSsoConfig } from "@/lib/sso-server";
import { readCappedBody, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * Trade the sign-in password for a one-time sign-in ticket.
 *
 * POST /api/auth/launch-ticket  { password }  ->  { ticket }
 *
 * Called by the desktop launcher, which then opens the browser on
 * /api/auth/launch?ticket=... so the person arrives signed in. See
 * launch-tickets.ts for why.
 *
 * This is the login route with a different reward, so it keeps the login
 * route's rules: the same password check, the same failure bucket and delay
 * (a wrong guess here counts against sign-in and the other way round), and the
 * same refusal when single sign-on is enforced and the password is switched
 * off. The same-origin check in the request gate applies as it does to every
 * mutating API call. A server that isn't the packaged build answers 404.
 */
const MAX_BODY_BYTES = 4 * 1024;
const MAX_FAILED_ATTEMPTS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAILED_ATTEMPT_DELAY_MS = 400;

export async function POST(req: NextRequest) {
  if (!launchTicketsSupported()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!authConfigured()) {
    return NextResponse.json(
      { error: "APP_PASSWORD is not set on the server" },
      { status: 503 }
    );
  }

  const raw = await readCappedBody(req, MAX_BODY_BYTES);
  if (raw === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  let body: { password?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.password !== "string" || !body.password || body.password.length > 1024) {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  let passwordAllowed = true;
  try {
    passwordAllowed = passwordLoginEnabled(readSsoConfig());
  } catch (e) {
    console.error("[auth] could not read SSO config; allowing password sign-in:", e);
  }
  if (!passwordAllowed) {
    return NextResponse.json(
      { error: "Password sign-in is turned off while single sign-on is enforced." },
      { status: 403 }
    );
  }

  // Same bucket as /api/auth/login: this must not be a second, unthrottled
  // place to guess the password.
  const key = `login:${clientKey(req)}`;
  const gate = peekRateLimit(key, MAX_FAILED_ATTEMPTS, FAIL_WINDOW_MS);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${gate.retryAfter}s.` },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } }
    );
  }
  if (!(await passwordMatches(body.password))) {
    rateLimit(key, MAX_FAILED_ATTEMPTS, FAIL_WINDOW_MS);
    await new Promise((r) => setTimeout(r, FAILED_ATTEMPT_DELAY_MS));
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  clearRateLimit(key);

  return NextResponse.json(
    { ticket: issueLaunchTicket() },
    { headers: { "cache-control": "no-store" } }
  );
}
