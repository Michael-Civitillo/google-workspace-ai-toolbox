import { google } from "googleapis";
import { readFileSync } from "fs";
import type { Tenant } from "./tenant-types";

/**
 * Pre-flight check for a tenant's Domain-Wide Delegation configuration.
 *
 * For each scope this toolbox needs, we attempt a token-exchange against
 * Google's OAuth servers. A `unauthorized_client` failure means DWD is set
 * up for the service account but the operator never added that specific
 * scope in Admin Console → Security → API controls → Domain-wide delegation.
 * Other auth errors (invalid_grant, bad admin email) surface verbatim.
 *
 * Run before — or any time after — a tenant is configured to catch missing
 * scopes upfront instead of finding out only when an end-user feature
 * silently fails.
 */

export interface ScopePreflightResult {
  scope: string;
  /** Short display name. */
  label: string;
  /** What this scope unlocks, so the operator knows what's at risk. */
  feature: string;
  authorized: boolean;
  /** Verbatim error from Google's auth server when not authorized. */
  error: string | null;
}

export interface PreflightResult {
  adminEmail: string;
  serviceAccountEmail: string | null;
  serviceAccountClientId: string | null;
  results: ScopePreflightResult[];
}

/**
 * The full set of OAuth scopes the toolbox impersonates with. Adding a new
 * feature that needs a new scope? Add it here so the preflight catches it.
 */
const REQUIRED_SCOPES: ReadonlyArray<{
  scope: string;
  label: string;
  feature: string;
}> = [
  {
    scope: "https://www.googleapis.com/auth/admin.directory.user",
    label: "Directory user",
    feature: "User lookup, suspension, primary-email change",
  },
  {
    scope: "https://www.googleapis.com/auth/admin.directory.user.security",
    label: "Directory user security",
    feature: "OAuth token revoke, force sign-out (offboarding)",
  },
  {
    scope: "https://www.googleapis.com/auth/admin.directory.domain.readonly",
    label: "Directory domains (read)",
    feature: "Verified-domain listing (drives external-sharing classification)",
  },
  {
    scope: "https://www.googleapis.com/auth/admin.datatransfer",
    label: "Data transfer",
    feature: "Drive ownership transfer during offboarding",
  },
  {
    scope: "https://www.googleapis.com/auth/drive.metadata.readonly",
    label: "Drive metadata (read)",
    feature: "External-sharing audit",
  },
  {
    scope: "https://www.googleapis.com/auth/drive",
    label: "Drive (full)",
    feature: "Revoke external sharing on files (un-share)",
  },
  {
    scope: "https://www.googleapis.com/auth/gmail.settings.sharing",
    label: "Gmail settings (sharing)",
    feature: "Email forwarding setup",
  },
  {
    scope: "https://www.googleapis.com/auth/gmail.settings.basic",
    label: "Gmail settings (basic)",
    feature: "Email delegation setup",
  },
  {
    scope: "https://www.googleapis.com/auth/calendar",
    label: "Calendar",
    feature: "Calendar delegation and transfer",
  },
] as const;

interface ServiceAccountCreds {
  client_email?: string;
  private_key?: string;
  client_id?: string;
}

export async function preflightTenantScopes(
  tenant: Tenant
): Promise<PreflightResult> {
  if (!tenant.adminEmail) {
    throw new Error(
      "Tenant has no adminEmail configured — DWD impersonation needs a super admin to impersonate"
    );
  }
  if (!tenant.credentialsFile) {
    throw new Error("Tenant has no credentialsFile configured");
  }

  let raw: string;
  try {
    raw = readFileSync(tenant.credentialsFile, "utf-8");
  } catch (e) {
    throw new Error(
      `Failed to read service account JSON at ${tenant.credentialsFile}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  let creds: ServiceAccountCreds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Service account file is not valid JSON: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  if (!creds.client_email || !creds.private_key) {
    throw new Error(
      "Service account JSON is missing client_email or private_key"
    );
  }

  // Run scope checks in parallel — Google's OAuth endpoint handles the
  // concurrency fine and the operator gets results in one round-trip's
  // worth of wall time rather than N.
  const results = await Promise.all(
    REQUIRED_SCOPES.map(async ({ scope, label, feature }) => {
      try {
        const auth = new google.auth.JWT({
          email: creds.client_email,
          key: creds.private_key,
          scopes: [scope],
          subject: tenant.adminEmail,
        });
        await auth.authorize();
        return {
          scope,
          label,
          feature,
          authorized: true,
          error: null,
        } satisfies ScopePreflightResult;
      } catch (e) {
        return {
          scope,
          label,
          feature,
          authorized: false,
          error: e instanceof Error ? e.message : String(e),
        } satisfies ScopePreflightResult;
      }
    })
  );

  return {
    adminEmail: tenant.adminEmail,
    serviceAccountEmail: creds.client_email ?? null,
    serviceAccountClientId: creds.client_id ?? null,
    results,
  };
}
