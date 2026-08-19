import { NextRequest, NextResponse } from "next/server";
import { getOidcConfiguration, SsoError } from "@/lib/oidc";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

const MAX_BODY_BYTES = 4 * 1024;
const DISCOVERY_TIMEOUT_MS = 12_000;

/**
 * Dry-run OIDC discovery for the settings form: fetch the issuer's metadata
 * and report the endpoints found, so a typo'd issuer URL surfaces before the
 * settings are saved. Needs only the issuer — no secret ever travels here.
 */
export async function POST(req: NextRequest) {
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }

  const issuer = typeof body.issuer === "string" ? body.issuer.trim() : "";
  if (!issuer) {
    return NextResponse.json({ error: "issuer is required" }, { status: 400 });
  }
  const clientId =
    typeof body.clientId === "string" && body.clientId.trim()
      ? body.clientId.trim()
      : "toolbox-discovery-check";

  try {
    // Race a timeout so a black-holed issuer can't hang the form; the losing
    // fetch is abandoned, not aborted, which is fine for a one-off check.
    const config = await Promise.race([
      getOidcConfiguration({ issuer, clientId }, { fresh: true }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new SsoError(
                "config",
                `Discovery timed out after ${DISCOVERY_TIMEOUT_MS / 1000}s`
              )
            ),
          DISCOVERY_TIMEOUT_MS
        )
      ),
    ]);
    const meta = config.serverMetadata();
    return NextResponse.json({
      ok: true,
      issuer: meta.issuer,
      authorizationEndpoint: meta.authorization_endpoint ?? null,
      tokenEndpoint: meta.token_endpoint ?? null,
      jwksUri: meta.jwks_uri ?? null,
      userinfoEndpoint: meta.userinfo_endpoint ?? null,
      supportsPkceS256:
        meta.code_challenge_methods_supported?.includes("S256") ?? null,
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Discovery failed for an unknown reason";
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
