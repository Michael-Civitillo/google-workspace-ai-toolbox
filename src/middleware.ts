import { NextResponse, type NextRequest } from "next/server";
import { authConfigured, verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  // Single sign-on: the login page needs to know what to offer, and the
  // provider round-trip happens before a session exists. The start route
  // gates its test mode on a session itself; the callback trusts only the
  // signed handshake cookie it issued.
  "/api/auth/sso/status",
  "/api/auth/oidc/start",
  "/api/auth/oidc/callback",
]);

/**
 * Edge middleware that enforces:
 *
 *   1. APP_PASSWORD must be set. If it isn't, the entire app refuses to serve
 *      anything except /login (which itself will tell the operator to set it).
 *      This means Open Admin can never be accidentally deployed wide-open.
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
              "Server not configured: APP_PASSWORD is not set. Open Admin refuses to run mutating actions without it.",
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
  // Referer against the *canonical* request host (req.nextUrl.host), which
  // Next.js derives from the address it bound — not the client-supplied Host
  // header, which is trivially spoofable behind a misconfigured proxy. Behind
  // a *correctly* configured proxy the public URL is unknowable from the
  // request, so the operator names it in APP_ALLOWED_ORIGINS instead.
  if (isApi && isMutating) {
    const expectedHost = req.nextUrl.host;
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");

    if (origin) {
      let originUrl: URL;
      try {
        originUrl = new URL(origin);
      } catch {
        return withSecurityHeaders(
          NextResponse.json({ error: "Invalid Origin header" }, { status: 400 })
        );
      }
      if (!isAllowedOrigin(expectedHost, originUrl)) {
        return withSecurityHeaders(
          NextResponse.json(
            { error: "Cross-origin request blocked" },
            { status: 403 }
          )
        );
      }
    } else if (referer) {
      let refererUrl: URL;
      try {
        refererUrl = new URL(referer);
      } catch {
        return withSecurityHeaders(
          NextResponse.json({ error: "Invalid Referer header" }, { status: 400 })
        );
      }
      if (!isAllowedOrigin(expectedHost, refererUrl)) {
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

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
// The "any interface" addresses. A server bound to one of these is reachable
// as localhost too — the Docker default, for instance — so a loopback Origin
// against an unspecified expected host is still the same machine.
const UNSPECIFIED_HOST = /^(?:0\.0\.0\.0|\[::\])$/;

/**
 * Public origins allowed to make mutating requests, from APP_ALLOWED_ORIGINS
 * (comma-separated, e.g. "https://admin.example.com").
 *
 * Behind a reverse proxy — Cloudflare Tunnel, nginx, a Docker network — the
 * browser's Origin is the public URL, while req.nextUrl.host is only ever the
 * address this process bound. Nothing in the request can tell the server its
 * public name safely (the Host header is attacker-controlled), so the operator
 * states it. Entries are normalised through URL#origin, which lowercases and
 * drops default ports exactly as browsers do when they send Origin, so the
 * comparison is a plain string equality.
 *
 * Parsed on first use: environment variables don't change while the process
 * runs, and a malformed entry is dropped rather than fatal — the app then
 * still works on its own host, which is the safe way to fail.
 */
let allowedOriginsCache: ReadonlySet<string> | null = null;

function allowedOrigins(): ReadonlySet<string> {
  if (allowedOriginsCache) return allowedOriginsCache;
  const out = new Set<string>();
  for (const part of (process.env.APP_ALLOWED_ORIGINS ?? "").split(",")) {
    const candidate = part.trim();
    if (!candidate) continue;
    try {
      const { origin } = new URL(candidate);
      if (origin !== "null") out.add(origin);
    } catch {
      // Ignored: see above.
    }
  }
  allowedOriginsCache = out;
  return out;
}

/** The CSRF decision: the server's own host, or an origin the operator named. */
function isAllowedOrigin(expectedHost: string, candidate: URL): boolean {
  return (
    sameOriginHost(expectedHost, candidate.host) ||
    allowedOrigins().has(candidate.origin)
  );
}

/** Split "host:port" into its parts, keeping bracketed IPv6 literals intact. */
function splitHostPort(hostport: string): [string, string] {
  const i = hostport.lastIndexOf(":");
  if (i === -1 || hostport.endsWith("]")) return [hostport, ""];
  return [hostport.slice(0, i), hostport.slice(i + 1)];
}

/**
 * Same-origin host comparison for the CSRF check above.
 *
 * Exact match is the normal answer. The one deliberate relaxation is the
 * local machine: Next canonicalises every loopback spelling in `req.nextUrl`
 * to `localhost`, so a user browsing http://127.0.0.1:3000 sends an Origin of
 * 127.0.0.1 against an expected host of localhost and would be refused even
 * though it is literally the same server; and a server bound to 0.0.0.0 (the
 * Docker default) reports that as its host while being reached as localhost.
 * All loopback names on the SAME port are that server; a different port is
 * still rejected, so another app on the machine can't forge requests here.
 */
function sameOriginHost(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  const [expectedHostname, expectedPort] = splitHostPort(expected);
  const [actualHostname, actualPort] = splitHostPort(actual);
  return (
    expectedPort === actualPort &&
    (LOOPBACK_HOST.test(expectedHostname) ||
      UNSPECIFIED_HOST.test(expectedHostname)) &&
    LOOPBACK_HOST.test(actualHostname)
  );
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
