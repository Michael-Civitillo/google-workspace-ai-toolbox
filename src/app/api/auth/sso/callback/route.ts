import { NextRequest, NextResponse } from "next/server";
import {
  authConfigured,
  createSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_TTL,
} from "@/lib/auth";
import { getAppConfig } from "@/lib/app-config";
import { audit } from "@/lib/audit";
import {
  completeSsoLogin,
  parseLoginStateToken,
  safeInternalPath,
  SsoError,
  OIDC_STATE_COOKIE_NAME,
  OIDC_STATE_COOKIE_PATH,
} from "@/lib/oidc";

/**
 * OIDC callback: the IdP redirects here with ?code&state. We check the signed
 * login-state cookie, exchange the code (state / nonce / PKCE / ID token all
 * verified inside completeSsoLogin), enforce the allowlist, and mint a
 * session.
 *
 * On success we respond with a tiny HTML page that navigates client-side
 * instead of a 302: the session cookie is SameSite=Strict, and browsers treat
 * the redirect chain from the IdP as cross-site — a server redirect straight
 * to "/" would arrive without the cookie and bounce back to /login. A
 * navigation initiated by our own page is same-site, so the cookie applies.
 */

function clearStateCookie(res: NextResponse): NextResponse {
  res.cookies.set(OIDC_STATE_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: OIDC_STATE_COOKIE_PATH,
    maxAge: 0,
  });
  return res;
}

function backToLogin(req: NextRequest, code: string): NextResponse {
  const url = new URL("/login", req.url);
  url.searchParams.set("ssoError", code);
  return clearStateCookie(NextResponse.redirect(url));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON-encode for embedding in a <script>, with `<` escaped so a crafted
 * path can never close the script tag. */
function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, "\\u003c");
}

export async function GET(req: NextRequest) {
  if (!authConfigured()) return backToLogin(req, "config");

  let sso;
  try {
    sso = getAppConfig().sso;
  } catch {
    return backToLogin(req, "config");
  }
  if (!sso?.enabled) return backToLogin(req, "disabled");

  const loginState = await parseLoginStateToken(
    req.cookies.get(OIDC_STATE_COOKIE_NAME)?.value
  );
  if (!loginState) {
    // Missing, expired, or tampered cookie — ask the user to start over.
    return backToLogin(req, "state");
  }

  try {
    const result = await completeSsoLogin(
      sso,
      loginState.redirectUri,
      req.nextUrl.search,
      {
        state: loginState.state,
        nonce: loginState.nonce,
        codeVerifier: loginState.codeVerifier,
      }
    );

    const token = await createSessionToken({
      sub: result.email,
      method: "sso",
    });

    audit({
      action: "auth.sso.login",
      tenantId: null,
      tenantName: null,
      params: { email: result.email, issuer: sso.issuer },
      outcome: "success",
      actor: result.email,
    });

    const next = safeInternalPath(loginState.next);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="1;url=${escapeHtml(next)}">
<title>Signing you in…</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#555}</style>
</head>
<body>
<p>Signed in — taking you to the toolbox…</p>
<script>window.location.replace(${jsString(next)});</script>
</body>
</html>`;

    const res = new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
    res.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL,
    });
    return clearStateCookie(res);
  } catch (e) {
    const code = e instanceof SsoError ? e.code : "exchange";
    console.error(
      "[sso] login failed:",
      e instanceof Error ? e.message : e
    );
    audit({
      action: "auth.sso.login",
      tenantId: null,
      tenantName: null,
      params: { issuer: sso.issuer, code },
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    return backToLogin(req, code);
  }
}
