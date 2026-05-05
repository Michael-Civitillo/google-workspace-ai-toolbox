import { NextRequest, NextResponse } from "next/server";
import {
  authConfigured,
  createSessionToken,
  passwordMatches,
  SESSION_COOKIE_NAME,
  SESSION_TTL,
} from "@/lib/auth";
import { rateLimit, clientKey } from "@/lib/rate-limit";

const MAX_BODY_BYTES = 4 * 1024; // login bodies are tiny — cap aggressively

export async function POST(req: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: "APP_PASSWORD is not set on the server" },
      { status: 503 }
    );
  }

  // 5 attempts per 15 minutes per IP. Generous enough for typos, tight enough
  // to make online brute-forcing of a strong password infeasible.
  const key = `login:${clientKey(req)}`;
  const limit = rateLimit(key, 5, 15 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Too many attempts. Try again in ${limit.retryAfter}s.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfter) },
      }
    );
  }

  // Bound the body size so a malicious caller can't blow up server memory.
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.password || typeof body.password !== "string") {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }
  if (body.password.length > 1024) {
    return NextResponse.json({ error: "Password too long" }, { status: 400 });
  }
  if (!passwordMatches(body.password)) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = await createSessionToken();
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL,
  });
  return res;
}
