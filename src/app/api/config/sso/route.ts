import { NextRequest, NextResponse } from "next/server";
import { getAppConfig, setSsoSettings, toPublicSso } from "@/lib/app-config";
import { parseOidcSettingsInput } from "@/lib/sso-validate";
import { audit } from "@/lib/audit";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

// SSO settings bodies are small; the allowlists are capped server-side too.
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Replace the SSO (OIDC) settings. The client sends the full desired state;
 * the only merge is the client secret, which is kept when the body omits it
 * (so the form never needs to echo the secret back) and dropped when
 * clearClientSecret is set.
 */
export async function PUT(req: NextRequest) {
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }

  try {
    const existing = getAppConfig().sso;
    const parsed = parseOidcSettingsInput(body, {
      existingSecret: existing?.clientSecret,
    });
    if (parsed.error) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const saved = await setSsoSettings(parsed.settings);
    audit({
      action: "config.sso.update",
      tenantId: null,
      tenantName: null,
      params: {
        enabled: parsed.settings?.enabled ?? false,
        issuer: parsed.settings?.issuer ?? null,
        clientId: parsed.settings?.clientId ?? null,
        passwordLoginEnabled: parsed.settings?.passwordLoginEnabled ?? true,
        allowedDomains: parsed.settings?.allowedDomains ?? [],
        allowedEmails: parsed.settings?.allowedEmails ?? [],
      },
      outcome: "success",
    });

    return NextResponse.json({
      sso: saved.sso ? toPublicSso(saved.sso) : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
