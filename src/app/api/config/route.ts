import { NextResponse } from "next/server";
import {
  getAppConfig,
  passwordLoginAllowed,
  toPublicSso,
} from "@/lib/app-config";
import { getTenantStoreSnapshot } from "@/lib/tenants-server";

/**
 * App-level configuration overview for the UI: onboarding state, public SSO
 * settings (secret stripped), and which sign-in methods are live. Also
 * carries the tenant count so the first-launch check is a single fetch.
 */
export async function GET() {
  try {
    const config = getAppConfig();
    const { tenants } = getTenantStoreSnapshot();
    return NextResponse.json({
      onboardingCompletedAt: config.onboardingCompletedAt,
      tenantCount: tenants.length,
      sso: config.sso ? toPublicSso(config.sso) : null,
      passwordGateSet: Boolean(process.env.APP_PASSWORD),
      passwordLoginAllowed: passwordLoginAllowed(),
      ssoRescueActive: process.env.SSO_RESCUE === "true",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
