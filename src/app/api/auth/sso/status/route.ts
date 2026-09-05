import { NextResponse } from "next/server";
import { getSsoLoginStatus } from "@/lib/sso-server";

/**
 * Public (pre-login) view of the sign-in options: whether to show the
 * "Continue with …" button and whether the password form is still offered.
 * Deliberately exposes nothing else about the configuration.
 */
export async function GET() {
  return NextResponse.json(getSsoLoginStatus(), {
    headers: { "cache-control": "no-store" },
  });
}
