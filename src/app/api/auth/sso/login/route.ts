import { NextRequest, NextResponse } from "next/server";
import { authConfigured } from "@/lib/auth";
import { getAppConfig } from "@/lib/app-config";
import {
  buildSsoAuthUrl,
  createLoginStateToken,
  resolveRedirectUri,
  safeInternalPath,
  SsoError,
  OIDC_STATE_COOKIE_NAME,
  OIDC_STATE_COOKIE_PATH,
  OIDC_STATE_TTL_SECONDS,
} from "@/lib/oidc";

/**
 * Starts an SSO login: generates state / nonce / PKCE verifier, parks them in
 * a short-lived signed cookie, and redirects the browser to the IdP's
 * authorization endpoint. Public route — this IS the way in.
 */

function backToLogin(req: NextRequest, code: string): NextResponse {
  const url = new URL("/login", req.url);
  url.searchParams.set("ssoError", code);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  // No signing secret at all → the transient cookie can't be protected and no
  // session could be issued anyway.
  if (!authConfigured()) return backToLogin(req, "config");

  let sso;
  try {
    sso = getAppConfig().sso;
  } catch {
    return backToLogin(req, "config");
  }
  if (!sso?.enabled) return backToLogin(req, "disabled");

  const next = safeInternalPath(req.nextUrl.searchParams.get("next"));

  try {
    const redirectUri = resolveRedirectUri(sso, req.nextUrl.origin);
    const start = await buildSsoAuthUrl(sso, redirectUri);
    const stateToken = await createLoginStateToken({
      state: start.state,
      nonce: start.nonce,
      codeVerifier: start.codeVerifier,
      next,
      redirectUri,
    });
    const res = NextResponse.redirect(start.authorizationUrl);
    res.cookies.set(OIDC_STATE_COOKIE_NAME, stateToken, {
      httpOnly: true,
      // Lax, not strict: the cookie must accompany the top-level GET the IdP
      // redirects back to our callback, which strict would drop.
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: OIDC_STATE_COOKIE_PATH,
      maxAge: OIDC_STATE_TTL_SECONDS,
    });
    return res;
  } catch (e) {
    console.error(
      "[sso] failed to start login:",
      e instanceof Error ? e.message : e
    );
    return backToLogin(req, e instanceof SsoError ? e.code : "config");
  }
}
