"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import type { SsoTestResult } from "@/lib/sso-types";

/** Next-step advice keyed by the failure codes the callback and popup emit. */
const HINTS: Record<string, string> = {
  not_allowed:
    "Add this address or its domain under \"Who can sign in\", save, and test again.",
  no_email:
    "Configure the provider to include an email claim in ID tokens (Microsoft Entra ID: Token configuration → add optional claim \"email\").",
  email_unverified:
    "The provider marks this address unverified. Verify it at the provider or sign in with a different account.",
  exchange_failed:
    "Check the client ID and secret, and that the redirect URI is registered exactly as shown in the wizard.",
  discovery_failed:
    "The server couldn't reach the issuer. Check the issuer URL and the server's outbound network access.",
  idp_denied:
    "The provider refused or the sign-in was cancelled. Make sure this account is assigned to the application.",
  idp_error:
    "The provider reported an error — the details above usually name the misconfigured setting.",
  popup_blocked: "Allow pop-ups for this site, then run the test again.",
  popup_closed: "Run the test again and complete the sign-in in the pop-up window.",
  unauthorized:
    "Your session expired while the wizard was open. Reload the page, sign in, and run the test again.",
  start_failed:
    "The server couldn't begin the sign-in. Check the server log for the full error.",
};

export function SsoTestResultPanel({ result }: { result: SsoTestResult }) {
  if (result.ok) {
    return (
      <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40 p-3 text-xs space-y-1">
        <p className="font-semibold text-emerald-900 dark:text-emerald-200 flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Sign-in test passed
        </p>
        <p className="text-emerald-800 dark:text-emerald-300">
          Signed in as <code className="font-mono">{result.email}</code>
          {result.name ? ` (${result.name})` : ""}.
        </p>
        {result.accessReason && (
          <p className="text-emerald-800 dark:text-emerald-300">
            Access granted because {result.accessReason}.
          </p>
        )}
        <p className="text-emerald-800/80 dark:text-emerald-300/80">
          No session was created by the test.
        </p>
      </div>
    );
  }

  const hint = result.code ? HINTS[result.code] : undefined;
  return (
    <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 p-3 text-xs space-y-1">
      <p className="font-semibold text-red-900 dark:text-red-200 flex items-center gap-1.5">
        <XCircle className="h-3.5 w-3.5" />
        Sign-in test failed
      </p>
      <p className="text-red-800 dark:text-red-300">
        {result.message ?? "The test did not complete."}
      </p>
      {result.email && (
        <p className="text-red-800 dark:text-red-300">
          Account: <code className="font-mono">{result.email}</code>
        </p>
      )}
      {result.detail && (
        <p className="text-red-800/90 dark:text-red-300/90 break-all">
          <code className="font-mono">{result.detail}</code>
        </p>
      )}
      {hint && <p className="text-red-800 dark:text-red-300 pt-1">{hint}</p>}
    </div>
  );
}
