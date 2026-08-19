import { NextRequest, NextResponse } from "next/server";
import { getAppConfig } from "@/lib/app-config";
import { getTenantStoreSnapshot } from "@/lib/tenants-server";
import { audit } from "@/lib/audit";
import {
  CONFIG_BUNDLE_KIND,
  CONFIG_BUNDLE_VERSION,
  type ConfigBundle,
} from "@/lib/app-config-types";
import type { Tenant } from "@/lib/tenant-types";

/**
 * Download the toolbox configuration as a portable JSON bundle: SSO settings,
 * onboarding state, and the full tenant list. Import it on another server via
 * POST /api/config/import.
 *
 * By default the bundle INCLUDES secrets (OIDC client secret, per-tenant
 * Gemini keys) — that's what makes it restorable elsewhere. `?secrets=0`
 * strips them for sharing a sanitised copy. Service-account JSON keys are
 * never bundled either way; only their paths are, and the files must exist on
 * the target machine.
 */
export async function GET(req: NextRequest) {
  const includeSecrets = req.nextUrl.searchParams.get("secrets") !== "0";
  try {
    const config = getAppConfig();
    const { tenants, activeTenantId } = getTenantStoreSnapshot();

    // hasGeminiApiKey is a response-only decoration — never export it.
    const exportTenants: Tenant[] = tenants.map((t) => {
      const { hasGeminiApiKey: _ignored, ...tenant } = t;
      void _ignored;
      if (!includeSecrets) delete tenant.geminiApiKey;
      return tenant;
    });

    const sso = config.sso
      ? includeSecrets
        ? config.sso
        : { ...config.sso, clientSecret: undefined }
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
    };

    audit({
      action: "config.export",
      tenantId: null,
      tenantName: null,
      params: { includeSecrets, tenantCount: exportTenants.length },
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
