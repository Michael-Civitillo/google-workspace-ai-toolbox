import { NextRequest, NextResponse } from "next/server";
import { validateIssuer } from "@/lib/sso-server";
import { checkIssuer } from "@/lib/oidc";
import { ValidationError } from "@/lib/validate";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

const MAX_BODY_BYTES = 4 * 1024;

/**
 * Wizard helper: fetch an issuer's discovery document and report what the
 * sign-in flow will rely on. Read-only against the provider; never touches
 * the stored configuration.
 */
export async function POST(req: NextRequest) {
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  let issuer: string;
  try {
    issuer = validateIssuer(body.issuer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid issuer";
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
  try {
    const result = await checkIssuer(issuer);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Discovery failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
