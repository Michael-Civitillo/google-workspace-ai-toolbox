import { NextRequest, NextResponse } from "next/server";
import { getAppConfig } from "@/lib/app-config";
import { getTenantStoreSnapshot } from "@/lib/tenants-server";
import { readSsoConfig } from "@/lib/sso-server";
import { collectCredentialFiles } from "@/lib/credential-files";
import { audit } from "@/lib/audit";
import {
  CONFIG_BUNDLE_KIND,
  CONFIG_BUNDLE_VERSION,
  type BundleSsoConfig,
  type ConfigBundle,
} from "@/lib/app-config-types";
import type { Tenant } from "@/lib/tenant-types";

/**
 * Download the app configuration as a portable JSON bundle: single sign-on
 * settings, onboarding state, the full tenant list, and the service-account
 * key files themselves. Import it on another server via
 * POST /api/config/import — a complete restore from one file, no side-channel
 * key copying.
 *
 * By default the bundle INCLUDES secrets (OIDC client secret, per-tenant
 * Gemini keys, and the embedded key files) — that's what makes it restorable
 * elsewhere. `?secrets=0` strips all of them for sharing a sanitised copy.
 */
export async function GET(req: NextRequest) {
  const includeSecrets = req.nextUrl.searchParams.get("secrets") !== "0";
  try {
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

    const bundle: ConfigBundle = {
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

    audit({
      action: "config.export",
      tenantId: null,
      tenantName: null,
      params: {
        includeSecrets,
        tenantCount: exportTenants.length,
        credentialFileCount: credentialFiles
          ? Object.keys(credentialFiles).length
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
