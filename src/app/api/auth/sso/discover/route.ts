import { NextRequest, NextResponse } from "next/server";
import { validateIssuer } from "@/lib/sso-server";
import { checkIssuer, OidcFlowError } from "@/lib/oidc";
import { ValidationError } from "@/lib/validate";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";
import { rateLimit, clientKey } from "@/lib/rate-limit";

const MAX_BODY_BYTES = 4 * 1024;

/**
 * Wizard helper: fetch an issuer's discovery document and report what the
 * sign-in flow will rely on. Read-only against the provider; never touches
 * the stored configuration.
 *
 * The server does the fetching, so nothing that describes the attempt itself
 * may come back here: private and loopback targets are refused outright
 * (validateIssuer) and a failure is reported as a verdict only, or this
 * endpoint would be a port scanner for the server's own network.
 */
// Each call makes the server fetch a URL the caller chose. Even refusing
// private targets, the difference between "could not be reached" and "answered
// but not with metadata" is a signal, so cap how fast anyone can sample it. A
// wizard run needs one or two checks; ten a minute is unnoticeable by hand.
const DISCOVER_LIMIT = 10;
const DISCOVER_WINDOW_MS = 60_000;

export async function POST(req: NextRequest) {
  const gate = rateLimit(
    `sso-discover:${clientKey(req)}`,
    DISCOVER_LIMIT,
    DISCOVER_WINDOW_MS
  );
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many issuer checks — wait a moment and try again" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } }
    );
  }

  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  let issuer: string;
  try {
    issuer = validateIssuer(body.issuer);
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[sso] issuer validation failed:", error);
    return NextResponse.json({ error: "Invalid issuer" }, { status: 500 });
  }
  try {
    const result = await checkIssuer(issuer);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    // Only text this app composed is shareable: a raw fetch failure would name
    // connection refused, a TLS error or a timeout for the address probed.
    if (error instanceof OidcFlowError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    }
    console.error("[sso] issuer check failed:", error);
    return NextResponse.json(
      { ok: false, error: "The issuer could not be reached" },
      { status: 502 }
    );
  }
}
