import { NextRequest, NextResponse } from "next/server";
import {
  readSsoConfig,
  saveSsoConfig,
  deleteSsoConfig,
  toPublicSsoConfig,
  ssoDisabledByEnv,
  SSO_CONFIG_PATH,
} from "@/lib/sso-server";
import { ValidationError } from "@/lib/validate";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";
import { audit } from "@/lib/audit";
import { identityFromRequest, describeActor } from "@/lib/session";

// Allowlists can hold a few hundred addresses; still tiny.
const MAX_BODY_BYTES = 64 * 1024;

export async function GET() {
  try {
    const cfg = readSsoConfig();
    return NextResponse.json({
      config: cfg ? toPublicSsoConfig(cfg) : null,
      envDisabled: ssoDisabledByEnv(),
      configPath: SSO_CONFIG_PATH,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Create or update the configuration. Missing fields keep their stored value. */
export async function PUT(req: NextRequest) {
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  const actor = describeActor(await identityFromRequest(req));
  try {
    const cfg = await saveSsoConfig(body);
    const pub = toPublicSsoConfig(cfg);
    audit({
      action: "auth.sso_config.save",
      tenantId: null,
      tenantName: null,
      params: {
        enabled: pub.enabled,
        provider: pub.provider,
        issuer: pub.issuer,
        clientId: pub.clientId,
        redirectUri: pub.redirectUri,
        allowedDomains: pub.allowedDomains,
        allowedEmails: pub.allowedEmails,
        allowAnyIdpUser: pub.allowAnyIdpUser,
        passwordLoginEnabled: pub.passwordLoginEnabled,
        // Redacted by the audit writer; recorded so a secret rotation is visible.
        clientSecret: typeof body.clientSecret === "string" && body.clientSecret ? "(rotated)" : "(unchanged)",
      },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ config: pub });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    audit({
      action: "auth.sso_config.save",
      tenantId: null,
      tenantName: null,
      params: {},
      outcome: "error",
      error: message,
      actor,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const actor = describeActor(await identityFromRequest(req));
  try {
    const removed = await deleteSsoConfig();
    audit({
      action: "auth.sso_config.delete",
      tenantId: null,
      tenantName: null,
      params: { removed },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ success: true, removed });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    audit({
      action: "auth.sso_config.delete",
      tenantId: null,
      tenantName: null,
      params: {},
      outcome: "error",
      error: message,
      actor,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
