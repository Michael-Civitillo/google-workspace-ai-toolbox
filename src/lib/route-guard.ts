import { NextResponse, type NextRequest } from "next/server";
import { authConfigured, SESSION_COOKIE_NAME, verifySessionToken } from "./auth";

/**
 * The session check again, inside each route.
 *
 * The request gate (src/proxy.ts) is the first line and refuses a request
 * without a valid session before any route runs. But it is one place: several
 * published Next.js advisories were requests shaped to get past exactly that
 * kind of gate. With this check at the top of every non-public route, such a
 * bug reaches a refusal instead of a Google call. It is the same check the
 * gate makes (signature, expiry, not signed out), so a request the gate let
 * through always passes it.
 *
 * Returns the response to send when the request must be refused, or null
 * when it may go on.
 */
export async function sessionRefusal(req: NextRequest): Promise<NextResponse | null> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: "Server not configured: APP_PASSWORD is not set." },
      { status: 503 }
    );
  }
  const ok = await verifySessionToken(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  return ok ? null : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
