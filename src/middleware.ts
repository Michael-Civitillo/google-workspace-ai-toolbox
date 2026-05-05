import { NextResponse, type NextRequest } from "next/server";
import { authConfigured, verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
]);

/**
 * Edge middleware that enforces:
 *
 *   1. APP_PASSWORD must be set. If it isn't, the entire app refuses to serve
 *      anything except /login (which itself will tell the operator to set it).
 *      This means the toolbox can never be accidentally deployed wide-open.
 *
 *   2. Authenticated session for every page and API route.
 *
 *   3. CSRF defence on mutating API requests: same-origin Origin / Referer
 *      header check, validated against the canonical request URL host (NOT
 *      the client-controlled Host header). This stops an attacker from using
 *      a forged Host header to bypass the same-origin check.
 *
 *   4. HSTS in production responses, so browsers refuse to fall back to HTTP.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Static assets and Next internals: let through.
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/logo.svg"
  ) {
    return withSecurityHeaders(NextResponse.next());
  }

  const isApi = pathname.startsWith("/api/");
  const method = req.method.toUpperCase();
  const isMutating =
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE";

  // Refuse to serve anything if no APP_PASSWORD has been configured.
  // The login page itself remains accessible so the operator can see why.
  if (!authConfigured()) {
    if (PUBLIC_PATHS.has(pathname)) {
      return withSecurityHeaders(NextResponse.next());
    }
    if (isApi) {
      return withSecurityHeaders(
        NextResponse.json(
          {
            error:
              "Server not configured: APP_PASSWORD is not set. The toolbox refuses to run mutating actions without it.",
          },
          { status: 503 }
        )
      );
    }
    return withSecurityHeaders(
      NextResponse.redirect(new URL("/login", req.url))
    );
  }

  const isPublic = PUBLIC_PATHS.has(pathname);

  if (!isPublic) {
    const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    const ok = await verifySessionToken(token);
    if (!ok) {
      if (isApi) {
        return withSecurityHeaders(
          NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        );
      }
      const url = new URL("/login", req.url);
      // Always pass `next` as the relative pathname only — never the full
      // request URL. The login page also re-validates this client-side.
      const safeNext = pathname.startsWith("/") && !pathname.startsWith("//")
        ? pathname
        : "/";
      url.searchParams.set("next", safeNext);
      return withSecurityHeaders(NextResponse.redirect(url));
    }
  }

  // CSRF: same-origin check on mutating API calls. Compare the Origin /
  // Referer host against the *canonical* request host (req.nextUrl.host),
  // which Next.js derives from the deployment's URL — not the client-supplied
  // Host header, which is trivially spoofable behind a misconfigured proxy.
  if (isApi && isMutating) {
    const expectedHost = req.nextUrl.host;
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");

    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        return withSecurityHeaders(
          NextResponse.json({ error: "Invalid Origin header" }, { status: 400 })
        );
      }
      if (originHost !== expectedHost) {
        return withSecurityHeaders(
          NextResponse.json(
            { error: "Cross-origin request blocked" },
            { status: 403 }
          )
        );
      }
    } else if (referer) {
      let refererHost: string;
      try {
        refererHost = new URL(referer).host;
      } catch {
        return withSecurityHeaders(
          NextResponse.json({ error: "Invalid Referer header" }, { status: 400 })
        );
      }
      if (refererHost !== expectedHost) {
        return withSecurityHeaders(
          NextResponse.json(
            { error: "Cross-origin request blocked" },
            { status: 403 }
          )
        );
      }
    } else {
      // Some clients legitimately omit both headers (e.g. fetch with
      // credentials: "same-origin" from same-origin script in Safari).
      // Accept ONLY if the request appears same-origin via the Sec-Fetch-Site
      // hint, otherwise reject.
      const site = req.headers.get("sec-fetch-site");
      if (site && site !== "same-origin" && site !== "none") {
        return withSecurityHeaders(
          NextResponse.json(
            { error: "Cross-origin request blocked" },
            { status: 403 }
          )
        );
      }
      if (!site) {
        return withSecurityHeaders(
          NextResponse.json(
            { error: "Missing Origin/Referer header" },
            { status: 403 }
          )
        );
      }
    }
  }

  return withSecurityHeaders(NextResponse.next());
}

function withSecurityHeaders(res: NextResponse): NextResponse {
  // HSTS: force HTTPS for a year on production. Browsers ignore this on
  // non-HTTPS responses, so it's safe to set unconditionally.
  if (process.env.NODE_ENV === "production") {
    res.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "same-origin");
  res.headers.set("X-Frame-Options", "DENY");
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
