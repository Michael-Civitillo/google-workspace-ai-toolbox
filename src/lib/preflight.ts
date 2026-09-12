import { JWT } from "google-auth-library";
import { readFileSync } from "fs";
import type { Tenant } from "./tenant-types";

/**
 * Pre-flight check for a tenant's Domain-Wide Delegation configuration.
 *
 * For each scope Open Admin needs, we attempt a token-exchange against
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
 * The full set of OAuth scopes Open Admin impersonates with. Adding a new
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
    scope: "https://www.googleapis.com/auth/admin.directory.group",
    label: "Directory groups",
    feature: "Group membership management + offboarding group removal",
  },
  {
    scope: "https://www.googleapis.com/auth/admin.reports.audit.readonly",
    label: "Reports (audit, read)",
    feature: "Sign-in/admin activity reports + AI security digest",
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
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    label: "Gmail (read)",
    feature: "Mailbox export (backup)",
  },
  {
    scope: "https://www.googleapis.com/auth/gmail.insert",
    label: "Gmail (insert)",
    feature: "Mailbox import (restore)",
  },
  {
    scope: "https://www.googleapis.com/auth/gmail.labels",
    label: "Gmail (labels)",
    feature: "Mailbox import — recreate labels",
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

  // Fixed messages only: the raw error would name the path and, for a parse
  // failure, quote the file's first bytes — and this text goes to the browser.
  let raw: string;
  try {
    raw = readFileSync(tenant.credentialsFile, "utf-8");
  } catch {
    throw new Error("Service account key file could not be read");
  }

  let creds: ServiceAccountCreds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error("Service account key file is not valid JSON");
  }

  if (
    !creds ||
    typeof creds !== "object" ||
    typeof creds.client_email !== "string" ||
    typeof creds.private_key !== "string"
  ) {
    throw new Error(
      "Service account key file is not a service-account key (missing client_email or private_key)"
    );
  }

  // Bound each token exchange. authorize() has no default timeout, so one
  // stalled connection to Google's OAuth endpoint would otherwise hang the
  // whole preflight (and the operator's "Check DWD scopes" spinner) forever.
  const AUTHORIZE_TIMEOUT_MS = 15_000;
  const withTimeout = <T>(p: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Token exchange timed out after ${AUTHORIZE_TIMEOUT_MS / 1000}s`
              )
            ),
          AUTHORIZE_TIMEOUT_MS
        );
      }),
    ]).finally(() => clearTimeout(timer)) as Promise<T>;
  };

  // Run scope checks in parallel — Google's OAuth endpoint handles the
  // concurrency fine and the operator gets results in one round-trip's
  // worth of wall time rather than N.
  const results = await Promise.all(
    REQUIRED_SCOPES.map(async ({ scope, label, feature }) => {
      try {
        const auth = new JWT({
          email: creds.client_email,
          key: creds.private_key,
          scopes: [scope],
          subject: tenant.adminEmail,
        });
        await withTimeout(auth.authorize());
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

/**
 * Cached wrapper around preflightTenantScopes, keyed by tenant id.
 *
 * One preflight fans out a JWT token exchange per scope (14 handshakes with
 * Google's OAuth endpoint, each with its own JWT client). The tenants and
 * onboarding pages ask for it on visit, so a few reloads would multiply into
 * dozens of outbound handshakes. Cache the answer briefly and coalesce
 * concurrent probes; `fresh` (the "Re-check" button) forces a real probe.
 */
const PREFLIGHT_CACHE_TTL_MS = 10_000;
const preflightCache = new Map<string, { at: number; value: PreflightResult }>();
const preflightInFlight = new Map<string, Promise<PreflightResult>>();

export interface CachedPreflight {
  result: PreflightResult;
  /** True when no token exchange was issued for this call — callers must not audit it as a DWD check. */
  cached: boolean;
}

// Keep the cache bounded: it is keyed by tenant id, so a long-lived server that
// sees tenants added and removed would otherwise retain an entry per tenant
// forever. Anything past its TTL is already unusable, so drop it on write.
function rememberPreflight(key: string, value: PreflightResult): void {
  const now = Date.now();
  for (const [k, entry] of preflightCache) {
    if (now - entry.at >= PREFLIGHT_CACHE_TTL_MS) preflightCache.delete(k);
  }
  preflightCache.set(key, { at: now, value });
}

export async function preflightTenantScopesCached(
  tenant: Tenant,
  opts: { fresh?: boolean } = {}
): Promise<CachedPreflight> {
  const key = tenant.id;
  if (!opts.fresh) {
    const hit = preflightCache.get(key);
    if (hit && Date.now() - hit.at < PREFLIGHT_CACHE_TTL_MS) {
      return { result: hit.value, cached: true };
    }
    // A coalesced caller rides along on a probe someone else started, which
    // that caller already audits — report it as cached so one fan-out to
    // Google never shows up as several DWD checks in the log.
    const inFlight = preflightInFlight.get(key);
    if (inFlight) return { result: await inFlight, cached: true };
  }
  const probe = preflightTenantScopes(tenant)
    .then((value) => {
      rememberPreflight(key, value);
      return value;
    })
    .finally(() => {
      if (preflightInFlight.get(key) === probe) preflightInFlight.delete(key);
    });
  preflightInFlight.set(key, probe);
  return { result: await probe, cached: false };
}
