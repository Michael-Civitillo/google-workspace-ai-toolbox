import { NextRequest, NextResponse } from "next/server";
import {
  authConfigured,
  createSessionToken,
  sessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";
import { readSsoConfig, recordSsoTest, ssoLoginAvailable } from "@/lib/sso-server";
import {
  completeOidcAuthorization,
  evaluateSsoAccess,
  OidcFlowError,
  type OidcMode,
} from "@/lib/oidc";
import {
  HANDSHAKE_COOKIE_NAME,
  handshakeCookieOptions,
  parseHandshake,
} from "@/lib/oidc-handshake";
import { renderRedirectPage, renderTestResultPage } from "@/lib/oidc-pages";
import { audit } from "@/lib/audit";
import { identityFromRequest, describeActor } from "@/lib/session";
import type { SsoTestResult } from "@/lib/sso-types";

/**
 * Where the identity provider sends the browser back to.
 *
 * Login mode ends with a session cookie plus a same-origin interstitial that
 * navigates on (see oidc-pages.ts for why that beats a bare redirect). Test
 * mode never creates a session: it renders the outcome for the wizard popup
 * and records it on the config so the SSO page can show "last tested".
 */
function html(markup: string): NextResponse {
  return new NextResponse(markup, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

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

/** The handshake cookie is single-use: drop it on every outcome. */
function clearHandshake(res: NextResponse): NextResponse {
  res.cookies.set(HANDSHAKE_COOKIE_NAME, "", {
    ...handshakeCookieOptions(),
    maxAge: 0,
  });
  return res;
}

function testPage(result: Omit<SsoTestResult, "type">): NextResponse {
  return html(renderTestResultPage({ type: "gws-sso-test", ...result }));
}

export async function GET(req: NextRequest) {
  if (!authConfigured()) return loginError("server_error");

  const handshake = await parseHandshake(
    req.cookies.get(HANDSHAKE_COOKIE_NAME)?.value
  );
  if (!handshake) {
    // No (or expired) handshake: we can't even tell which mode this was, so
    // the login page's generic "try again" is the best available answer.
    return clearHandshake(loginError("session_expired"));
  }
  const mode: OidcMode = handshake.mode;

  let cfg;
  try {
    cfg = readSsoConfig();
  } catch (e) {
    console.error("[sso] could not read config:", e);
    return clearHandshake(
      mode === "test"
        ? testPage({
            ok: false,
            code: "server_error",
            message: "Could not read the single sign-on configuration",
            detail: e instanceof Error ? e.message : String(e),
          })
        : loginError("server_error")
    );
  }
  if (!cfg) {
    return clearHandshake(
      mode === "test"
        ? testPage({
            ok: false,
            code: "not_configured",
            message: "Single sign-on is no longer configured",
          })
        : loginError("not_configured")
    );
  }
  if (mode === "login" && !ssoLoginAvailable(cfg)) {
    return clearHandshake(loginError("disabled"));
  }

  const auditAction = mode === "test" ? "auth.sso_test" : "auth.sso_login";
  // In test mode the person running the test is the actor; in login mode the
  // actor is whoever the provider just authenticated. The tester's identity
  // travels in the signed handshake: this request is the provider's cross-site
  // redirect, on which the browser withholds the Strict session cookie, so
  // reading it here would always report the anonymous password session.
  const testerActor =
    mode === "test"
      ? handshake.actor ?? describeActor(await identityFromRequest(req))
      : undefined;

  let failure: OidcFlowError;
  let failedEmail: string | undefined;
  try {
    const { identity, claimNames } = await completeOidcAuthorization(
      cfg,
      req.nextUrl.search,
      handshake
    );
    const access = evaluateSsoAccess(cfg, identity.email);

    if (!access.allowed) {
      failedEmail = identity.email;
      failure = new OidcFlowError(
        "not_allowed",
        "This account isn't allowed to use Open Admin",
        access.reason
      );
    } else if (mode === "test") {
      await recordSsoTest({
        at: new Date().toISOString(),
        ok: true,
        email: identity.email,
      }).catch((e) => console.error("[sso] could not record test result:", e));
      audit({
        action: auditAction,
        tenantId: null,
        tenantName: null,
        params: {
          email: identity.email,
          emailSource: identity.emailSource,
          issuer: cfg.issuer,
          claims: claimNames,
          access: access.reason,
        },
        outcome: "success",
        actor: testerActor,
      });
      return clearHandshake(
        testPage({
          ok: true,
          email: identity.email,
          name: identity.name ?? undefined,
          sub: identity.sub,
          issuer: cfg.issuer,
          accessReason: access.reason,
        })
      );
    } else {
      const token = await createSessionToken({
        method: "oidc",
        email: identity.email,
        name: identity.name ?? undefined,
        sub: identity.sub,
      });
      audit({
        action: auditAction,
        tenantId: null,
        tenantName: null,
        params: {
          email: identity.email,
          emailSource: identity.emailSource,
          issuer: cfg.issuer,
          access: access.reason,
        },
        outcome: "success",
        actor: identity.email,
      });
      const res = html(renderRedirectPage(handshake.next));
      res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
      return clearHandshake(res);
    }
  } catch (e) {
    failure =
      e instanceof OidcFlowError
        ? e
        : new OidcFlowError(
            "exchange_failed",
            "Could not complete sign-in",
            e instanceof Error ? e.message : String(e)
          );
  }

  // Failure path (shared by thrown errors and the allowlist refusal).
  console.warn(
    `[sso] ${mode} failed: ${failure.code} — ${failure.message}${
      failure.detail ? ` (${failure.detail})` : ""
    }`
  );
  audit({
    action: auditAction,
    tenantId: null,
    tenantName: null,
    params: {
      issuer: cfg.issuer,
      code: failure.code,
      detail: failure.detail ?? null,
      email: failedEmail ?? null,
    },
    outcome: "error",
    error: failure.message,
    actor: testerActor ?? failedEmail,
  });

  if (mode === "test") {
    await recordSsoTest({
      at: new Date().toISOString(),
      ok: false,
      email: failedEmail,
      error: failure.detail
        ? `${failure.message} (${failure.detail})`
        : failure.message,
    }).catch((err) => console.error("[sso] could not record test result:", err));
    return clearHandshake(
      testPage({
        ok: false,
        code: failure.code,
        message: failure.message,
        detail: failure.detail,
        email: failedEmail,
        accessReason: failure.code === "not_allowed" ? failure.detail : undefined,
      })
    );
  }
  return clearHandshake(loginError(failure.code));
}
