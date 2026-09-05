import { NextRequest, NextResponse } from "next/server";
import { authConfigured, verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { readSsoConfig, ssoLoginAvailable } from "@/lib/sso-server";
import { beginOidcAuthorization, type OidcMode } from "@/lib/oidc";
import {
  HANDSHAKE_COOKIE_NAME,
  handshakeCookieOptions,
  serializeHandshake,
  safeNextPath,
} from "@/lib/oidc-handshake";
import { renderTestResultPage } from "@/lib/oidc-pages";

/**
 * Kick off a single sign-on attempt.
 *
 * `mode=login` (default) is reachable without a session: it is what the
 * "Continue with …" button on the login page links to. `mode=test` is used by
 * the setup wizard's popup and requires an existing session, so the config
 * can be exercised end to end without ever issuing a session from it.
 */
function loginError(req: NextRequest, code: string): NextResponse {
  const url = new URL("/login", req.url);
  url.searchParams.set("sso_error", code);
  const res = NextResponse.redirect(url, 302);
  res.headers.set("cache-control", "no-store");
  return res;
}

function testFailure(message: string, detail?: string): NextResponse {
  return new NextResponse(
    renderTestResultPage({
      type: "gws-sso-test",
      ok: false,
      code: "start_failed",
      message,
      detail,
    }),
    {
      status: 200,
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
      : loginError(req, "server_error");
  }

  if (mode === "test") {
    const ok = await verifySessionToken(
      req.cookies.get(SESSION_COOKIE_NAME)?.value
    );
    if (!ok) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
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
      : loginError(req, "server_error");
  }
  if (!cfg) {
    return mode === "test"
      ? testFailure("Single sign-on isn't configured yet — save the configuration first")
      : loginError(req, "not_configured");
  }
  if (mode === "login" && !ssoLoginAvailable(cfg)) {
    return loginError(req, "disabled");
  }

  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  try {
    const { url, handshake } = await beginOidcAuthorization(cfg, mode, next);
    const res = NextResponse.redirect(url, 302);
    res.cookies.set(
      HANDSHAKE_COOKIE_NAME,
      await serializeHandshake(handshake),
      handshakeCookieOptions()
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
      : loginError(req, "discovery_failed");
  }
}
