import { NextResponse } from "next/server";
import { authConfigured } from "@/lib/auth";
import { getAppConfig, passwordLoginAllowed } from "@/lib/app-config";

/**
 * Which sign-in methods the login page should offer. Public (pre-auth) by
 * design, so it must stay low-disclosure: the only SSO detail exposed is the
 * button label — never the issuer, client id, or allowlists.
 */
export async function GET() {
  let sso: { buttonLabel: string } | null = null;
  let password = false;
  try {
    const config = getAppConfig();
    if (config.sso?.enabled) {
      sso = { buttonLabel: config.sso.buttonLabel };
    }
    password = passwordLoginAllowed();
  } catch {
    // A transient config read failure must not take the login page down —
    // fall back to whatever the environment alone can answer.
    password = Boolean(process.env.APP_PASSWORD);
  }
  return NextResponse.json({
    configured: authConfigured(),
    passwordGateSet: Boolean(process.env.APP_PASSWORD),
    password,
    sso,
  });
}
