import { NextRequest, NextResponse } from "next/server";
import { getAppConfig } from "@/lib/app-config";
import { getTenantStoreSnapshot } from "@/lib/tenants-server";
import { readSsoConfig } from "@/lib/sso-server";
import { collectCredentialFiles } from "@/lib/credential-files";
import { audit } from "@/lib/audit";
import { describeActor, identityFromRequest } from "@/lib/session";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";
import {
  CONFIG_BUNDLE_KIND,
  CONFIG_BUNDLE_VERSION,
  type BundleSsoConfig,
  type ConfigBundle,
} from "@/lib/app-config-types";
import type { Tenant } from "@/lib/tenant-types";

/**
 * Download the app configuration as a portable JSON bundle: single sign-on
 * settings, onboarding state, the full tenant list, and — on request — the
 * service-account key files themselves. Import it on another server via
 * POST /api/config/import for a complete restore from one file.
 *
 *   GET  /api/config/export   sanitised bundle: no client secret, no Gemini
 *                             keys, no key files. Safe to hand around.
 *   POST /api/config/export   the full bundle including every secret. Needs
 *                             { confirm: "EXPORT SECRETS" } in the body: one
 *                             download carries every private key this
 *                             server holds, so it is a deliberate, audited,
 *                             origin-checked act rather than a link.
 */
export const EXPORT_SECRETS_PHRASE = "EXPORT SECRETS";
const MAX_BODY_BYTES = 4 * 1024;

function buildBundle(includeSecrets: boolean): ConfigBundle {
  const config = getAppConfig();
  const ssoConfig = readSsoConfig();
  const { tenants, activeTenantId } = getTenantStoreSnapshot();
  const credentialFiles = includeSecrets
    ? collectCredentialFiles(tenants)
    : undefined;

  // hasGeminiApiKey is a response-only decoration — never export it.
  const exportTenants: Tenant[] = tenants.map((t) => {
    const { hasGeminiApiKey: _ignored, ...tenant } = t;
    void _ignored;
    if (!includeSecrets) delete tenant.geminiApiKey;
    return tenant;
  });

  const sso: BundleSsoConfig | null = ssoConfig
    ? includeSecrets
      ? ssoConfig
      : { ...ssoConfig, clientSecret: undefined }
    : null;

  return {
    kind: CONFIG_BUNDLE_KIND,
    version: CONFIG_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    includesSecrets: includeSecrets,
    app: {
      sso,
      onboardingCompletedAt: config.onboardingCompletedAt,
    },
    tenants: {
      activeTenantId,
      tenants: exportTenants,
    },
    credentialFiles,
  };
}

async function respondWithBundle(req: NextRequest, includeSecrets: boolean) {
  const actor = describeActor(await identityFromRequest(req));
  try {
    const bundle = buildBundle(includeSecrets);
    audit({
      action: "config.export",
      actor,
      tenantId: null,
      tenantName: null,
      params: {
        includeSecrets,
        tenantCount: bundle.tenants.tenants.length,
        credentialFileCount: bundle.credentialFiles
          ? Object.keys(bundle.credentialFiles).length
          : 0,
      },
      outcome: "success",
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="gws-toolbox-config-${stamp}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("secrets") === "1") {
    return NextResponse.json(
      {
        error: `Secrets are only exported through POST with confirm: "${EXPORT_SECRETS_PHRASE}".`,
      },
      { status: 400 }
    );
  }
  return respondWithBundle(req, false);
}

export async function POST(req: NextRequest) {
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  const confirm = typeof body.confirm === "string" ? body.confirm.trim() : "";
  if (confirm !== EXPORT_SECRETS_PHRASE) {
    return NextResponse.json(
      {
        error: `Type ${EXPORT_SECRETS_PHRASE} into the confirm field to export the bundle with secrets.`,
      },
      { status: 400 }
    );
  }
  return respondWithBundle(req, true);
}
