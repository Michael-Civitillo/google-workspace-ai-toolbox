import { NextRequest, NextResponse } from "next/server";
import {
  authConfigured,
  createSessionToken,
  passwordMatches,
  SESSION_COOKIE_NAME,
  SESSION_TTL,
} from "@/lib/auth";

export async function POST(req: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: "APP_PASSWORD is not set on the server" },
      { status: 503 }
    );
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
