import { NextResponse, type NextRequest } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { getAppConfig } from "@/lib/app-config";
import { getTenantStoreSnapshot } from "@/lib/tenants-server";
import {
  passwordLoginEnabled,
  readSsoConfig,
  ssoDisabledByEnv,
  toPublicSsoConfig,
} from "@/lib/sso-server";

/**
 * App-level configuration overview for the UI: onboarding state, the public
 * single sign-on settings (secret stripped), and which sign-in methods are
 * live. Also carries the tenant count so the first-launch check is a single
 * fetch.
 */
export async function GET(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  try {
    const config = getAppConfig();
    const { tenants } = getTenantStoreSnapshot();
    const sso = readSsoConfig();
    return NextResponse.json(
      {
        onboardingCompletedAt: config.onboardingCompletedAt,
        tenantCount: tenants.length,
        sso: sso ? toPublicSsoConfig(sso) : null,
        passwordGateSet: Boolean(process.env.APP_PASSWORD),
        passwordLoginAllowed: passwordLoginEnabled(sso),
        ssoDisabledByEnv: ssoDisabledByEnv(),
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
