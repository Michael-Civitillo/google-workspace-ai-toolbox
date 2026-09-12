import { NextRequest, NextResponse } from "next/server";
import { authConfigured } from "@/lib/auth";
import { readSsoConfig, ssoLoginAvailable } from "@/lib/sso-server";
import { beginOidcAuthorization, type OidcMode } from "@/lib/oidc";
import {
  HANDSHAKE_COOKIE_NAME,
  handshakeCookieOptions,
  serializeHandshake,
  safeNextPath,
} from "@/lib/oidc-handshake";
import { renderTestResultPage } from "@/lib/oidc-pages";
import { identityFromRequest, describeActor } from "@/lib/session";

/**
 * Kick off a single sign-on attempt.
 *
 * `mode=login` (default) is reachable without a session: it is what the
 * "Continue with …" button on the login page links to. `mode=test` is used by
 * the setup wizard's popup and requires an existing session, so the config
 * can be exercised end to end without ever issuing a session from it.
 */
/**
 * Bounce to the login page with an error code.
 *
 * The Location is deliberately relative. `req.url` here is the address this
 * server bound - localhost, or 0.0.0.0 in a container - not the URL the
 * browser used, so an absolute redirect built from it would send anyone behind
 * a reverse proxy (Cloudflare Tunnel, nginx) to a host that doesn't exist for
 * them. Browsers resolve a relative Location against the page they asked for.
 */
function loginError(code: string): NextResponse {
  const params = new URLSearchParams({ sso_error: code });
  return new NextResponse(null, {
    status: 302,
    headers: { location: `/login?${params}`, "cache-control": "no-store" },
  });
}

function testFailure(
  message: string,
  detail?: string,
  code = "start_failed",
  status = 200
): NextResponse {
  return new NextResponse(
    renderTestResultPage({
      type: "gws-sso-test",
      ok: false,
      code,
      message,
      detail,
    }),
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
}

export async function GET(req: NextRequest) {
  const mode: OidcMode =
    req.nextUrl.searchParams.get("mode") === "test" ? "test" : "login";

  if (!authConfigured()) {
    return mode === "test"
      ? testFailure("APP_PASSWORD is not set on the server")
      : loginError("server_error");
  }

  // Test mode runs inside the wizard's pop-up and needs a session. This is a
  // same-origin navigation, so the Strict session cookie is present here —
  // and this is the only place the tester's identity can be read (the
  // callback arrives from the provider, cross-site, without that cookie).
  let actor: string | undefined;
  if (mode === "test") {
    const identity = await identityFromRequest(req);
    if (!identity) {
      // Render a result page rather than bare JSON: the wizard is listening
      // for the pop-up's message and would otherwise wait until the window
      // is closed by hand.
      return testFailure(
        "Your Open Admin session has expired — sign in again and re-run the test",
        undefined,
        "unauthorized",
        401
      );
    }
    actor = describeActor(identity);
  }

  let cfg;
  try {
    cfg = readSsoConfig();
  } catch (e) {
    console.error("[sso] could not read config:", e);
    return mode === "test"
      ? testFailure(
          "Could not read the single sign-on configuration",
          e instanceof Error ? e.message : String(e)
        )
      : loginError("server_error");
  }
  if (!cfg) {
    return mode === "test"
      ? testFailure("Single sign-on isn't configured yet — save the configuration first")
      : loginError("not_configured");
  }
  if (mode === "login" && !ssoLoginAvailable(cfg)) {
    return loginError("disabled");
  }

  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  try {
    const { url, handshake } = await beginOidcAuthorization(
      cfg,
      mode,
      next,
      actor
    );
    const res = NextResponse.redirect(url, 302);
    res.cookies.set(
      HANDSHAKE_COOKIE_NAME,
      await serializeHandshake(handshake),
      handshakeCookieOptions(req)
    );
    res.headers.set("cache-control", "no-store");
    return res;
  } catch (e) {
    console.error("[sso] could not start sign-in:", e);
    return mode === "test"
      ? testFailure(
          "Could not reach the identity provider",
          e instanceof Error ? e.message : String(e)
        )
      : loginError("discovery_failed");
  }
}
