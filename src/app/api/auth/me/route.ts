import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

/**
 * Who is signed in on this session. The middleware already gates this route,
 * but we re-verify rather than trusting that — the payload is needed anyway.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionToken(
    req.cookies.get(SESSION_COOKIE_NAME)?.value
  );
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    sub: session.sub,
    method: session.method,
    expiresAt: session.exp,
  });
}
