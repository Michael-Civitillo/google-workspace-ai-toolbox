import { NextRequest, NextResponse } from "next/server";
import {
  authConfigured,
  createSessionToken,
  sessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";
import { launchTicketsSupported, redeemLaunchTicket } from "@/lib/launch-tickets";
import { renderRedirectPage } from "@/lib/oidc-pages";

/**
 * Redeem a one-time sign-in ticket for a session.
 *
 * GET /api/auth/launch?ticket=...
 *
 * The desktop launcher opens the browser here. A valid ticket sets the same
 * session cookie a password sign-in would and lands on a same-origin page that
 * navigates on to the dashboard (the same interstitial the single sign-on
 * callback uses, for the same SameSite=Strict reason). Anything else, a used,
 * expired or made-up ticket included, goes to the ordinary sign-in page with
 * no hint as to why: there is nothing useful to tell a stranger.
 *
 * A GET that signs someone in is safe here only because the ticket is the
 * credential: unguessable, single-use, and a minute long.
 */
function toLogin(): NextResponse {
  // Relative on purpose: see the note on loginError in the OIDC callback.
  return new NextResponse(null, {
    status: 302,
    headers: { location: "/login", "cache-control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  if (!launchTicketsSupported()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!authConfigured()) return toLogin();
  if (!redeemLaunchTicket(req.nextUrl.searchParams.get("ticket"))) return toLogin();

  const token = await createSessionToken({ method: "password" });
  const nonce = req.headers.get("x-nonce") ?? undefined;
  const res = new NextResponse(renderRedirectPage("/", nonce), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The ticket is in this URL; keep it out of any Referer.
      "referrer-policy": "no-referrer",
    },
  });
  res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(req));
  return res;
}
