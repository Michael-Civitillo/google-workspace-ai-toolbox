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
 *   3. CSRF defence on mutating API requests: same-origin Origin header check.
 *      Non-mutating GETs are unaffected; mutating verbs (POST/PUT/PATCH/DELETE)
 *      to /api/* must come from the same origin we serve.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Static assets and Next internals: let through.
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/logo.svg"
  ) {
    return NextResponse.next();
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
    if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
    if (isApi) {
      return NextResponse.json(
        {
          error:
            "Server not configured: APP_PASSWORD is not set. The toolbox refuses to run mutating actions without it.",
        },
        { status: 503 }
      );
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // Public auth endpoints are always allowed past auth (still get CSRF check below).
  const isPublic = PUBLIC_PATHS.has(pathname);

  if (!isPublic) {
    const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    const ok = await verifySessionToken(token);
    if (!ok) {
      if (isApi) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const url = new URL("/login", req.url);
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
  }

  // CSRF: same-origin check on mutating API calls.
  if (isApi && isMutating) {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        return NextResponse.json(
          { error: "Invalid Origin header" },
          { status: 400 }
        );
      }
      if (originHost !== host) {
        return NextResponse.json(
          { error: "Cross-origin request blocked" },
          { status: 403 }
        );
      }
    } else {
      // Some clients (e.g. native fetch from same-origin script in some browsers)
      // omit Origin. Fall back to Referer if present; otherwise reject.
      const referer = req.headers.get("referer");
      if (!referer) {
        return NextResponse.json(
          { error: "Missing Origin/Referer header" },
          { status: 403 }
        );
      }
      let refererHost: string;
      try {
        refererHost = new URL(referer).host;
      } catch {
        return NextResponse.json(
          { error: "Invalid Referer header" },
          { status: 400 }
        );
      }
      if (refererHost !== host) {
        return NextResponse.json(
          { error: "Cross-origin request blocked" },
          { status: 403 }
        );
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
