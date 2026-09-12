import { NextRequest, NextResponse } from "next/server";
import { revokeSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

/**
 * Sign out: clear the cookie AND revoke the token server-side, so a copy of
 * it (a leaked cookie, another tab's request in flight) stops working now
 * rather than at expiry.
 */
export async function POST(req: NextRequest) {
  revokeSessionToken(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
