import { NextRequest, NextResponse } from "next/server";
import {
  authConfigured,
  createSessionToken,
  passwordMatches,
  SESSION_COOKIE_NAME,
  SESSION_TTL,
} from "@/lib/auth";
import { rateLimit, clearRateLimit, clientKey } from "@/lib/rate-limit";
import { readCappedBody, BODY_TOO_LARGE } from "@/lib/request-body";

const MAX_BODY_BYTES = 4 * 1024; // login bodies are tiny — cap aggressively
// Cap FAILED attempts, not all attempts. 5 wrong guesses per 15 minutes is
// generous enough for typos and tight enough to make online brute-forcing a
// strong password infeasible.
const MAX_FAILED_ATTEMPTS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

export async function POST(req: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: "APP_PASSWORD is not set on the server" },
      { status: 503 }
    );
  }

  const key = `login:${clientKey(req)}`;

  // Bound the body size so a malicious caller can't blow up server memory.
  const raw = await readCappedBody(req, MAX_BODY_BYTES);
  if (raw === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }

  let body: { password?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.password || typeof body.password !== "string") {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }
  if (body.password.length > 1024) {
    return NextResponse.json({ error: "Password too long" }, { status: 400 });
  }

  // Check the password BEFORE consulting the rate limiter, and only count
  // FAILED attempts. A correct password is therefore never blocked — critical
  // because, without a trusted proxy, every client shares one "anon" bucket, so
  // gating all attempts would let anyone lock the real admin out by burning the
  // shared quota. Here a flood of wrong guesses only ever throttles further
  // wrong guesses; the operator's correct password always gets through.
  if (!(await passwordMatches(body.password))) {
    const limit = rateLimit(key, MAX_FAILED_ATTEMPTS, FAIL_WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${limit.retryAfter}s.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
      );
    }
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  // Success: clear any recorded failures so earlier typos don't count against
  // the next login.
  clearRateLimit(key);

  const token = await createSessionToken();
  const res = NextResponse.json({ success: true });
  // `strict` blocks the cookie on any cross-site navigation, top-level or
  // otherwise. The toolbox has no flow that depends on inbound cross-site
  // links, so this gives us belt-and-braces CSRF protection on top of the
  // Origin/Referer check enforced by the middleware.
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL,
  });
  return res;
}
