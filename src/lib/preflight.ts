import { REQUIRED_SCOPES } from "./required-scopes";
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

/** Every scope Open Admin asks Google for, and no others. */
export function usedScopes(): string[] {
  return REQUIRED_SCOPES.map((s) => s.scope);
}

interface ServiceAccountCreds {
  client_email?: string;
  private_key?: string;
  client_id?: string;
}

/**
 * Read and validate a tenant's key file.
 *
 * Fixed messages only: the raw error would name the path and, for a parse
 * failure, quote the file's first bytes — and this text goes to the browser.
 */
function readServiceAccount(tenant: Tenant): ServiceAccountCreds {
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
  return creds;
}

// Bound each token exchange. authorize() has no default timeout, so one
// stalled connection to Google's OAuth endpoint would otherwise hang the
// whole preflight (and the operator's "Check DWD scopes" spinner) forever.
const AUTHORIZE_TIMEOUT_MS = 15_000;

/**
 * Ask Google for a token for one scope, impersonating the tenant's admin.
 * Resolves if the scope is authorised for this service account; rejects with
 * Google's error otherwise. The token itself is discarded: nothing is read
 * or changed with it.
 */
async function mintToken(
  creds: ServiceAccountCreds,
  adminEmail: string,
  scope: string
): Promise<void> {
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [scope],
    subject: adminEmail,
  });
  let timer: ReturnType<typeof setTimeout>;
  await Promise.race([
    auth.authorize(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`Token exchange timed out after ${AUTHORIZE_TIMEOUT_MS / 1000}s`)
          ),
        AUTHORIZE_TIMEOUT_MS
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Broad access Open Admin never asks for. If the tenant's delegation entry
 * for this service account includes any of these, the key file is worth more
 * to a thief than it needs to be.
 */
const UNNEEDED_BROAD_SCOPES: ReadonlyArray<{
  scope: string;
  label: string;
  meaning: string;
}> = [
  {
    scope: "https://mail.google.com/",
    label: "Full Gmail access",
    meaning: "read, send and delete any user's mail",
  },
  {
    scope: "https://www.googleapis.com/auth/gmail.modify",
    label: "Gmail (read and change)",
    meaning: "read and change any user's mail",
  },
  {
    scope: "https://www.googleapis.com/auth/gmail.send",
    label: "Gmail (send)",
    meaning: "send mail as any user",
  },
  {
    scope: "https://www.googleapis.com/auth/admin.directory.rolemanagement",
    label: "Admin roles",
    meaning: "make any account an administrator",
  },
  {
    scope: "https://www.googleapis.com/auth/cloud-platform",
    label: "Google Cloud",
    meaning: "manage Google Cloud resources as any user",
  },
  {
    scope: "https://www.googleapis.com/auth/ediscovery",
    label: "Vault",
    meaning: "search and export retained mail and files",
  },
];

export interface OwnKeyProbe {
  scope: string;
  label: string;
  meaning: string;
  /** true: granted. false: Google refused it. null: the answer wasn't clear. */
  granted: boolean | null;
  /** Google's error when the answer wasn't a clean yes or no. */
  error: string | null;
}

export interface OwnKeyResult {
  serviceAccountEmail: string | null;
  serviceAccountClientId: string | null;
  probes: OwnKeyProbe[];
}

/**
 * Ask Google directly whether this tenant has authorised Open Admin's own
 * service account for broad access it never uses.
 *
 * The admin log only shows delegation changes from the last six months; this
 * is the one way to learn about an older, over-generous grant. It works by
 * asking for a token for each scope and discarding it. Nothing is read or
 * changed, but each request is a token grant Google records against this
 * service account, which is why the page runs it only on an explicit click.
 *
 * Only an `unauthorized_client` refusal counts as "not granted". Any other
 * failure (network, a revoked key, a wrong admin address) is reported as
 * unknown rather than as good news.
 */
export async function probeUnneededScopes(tenant: Tenant): Promise<OwnKeyResult> {
  if (!tenant.adminEmail) {
    throw new Error(
      "Tenant has no adminEmail configured — DWD impersonation needs a super admin to impersonate"
    );
  }
  if (!tenant.credentialsFile) {
    throw new Error("Tenant has no credentialsFile configured");
  }
  const creds = readServiceAccount(tenant);
  const used = new Set(REQUIRED_SCOPES.map((s) => s.scope));

  const probes = await Promise.all(
    UNNEEDED_BROAD_SCOPES.filter((s) => !used.has(s.scope)).map(
      async ({ scope, label, meaning }): Promise<OwnKeyProbe> => {
        try {
          await mintToken(creds, tenant.adminEmail, scope);
          return { scope, label, meaning, granted: true, error: null };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return /unauthorized_client/i.test(message)
            ? { scope, label, meaning, granted: false, error: null }
            : { scope, label, meaning, granted: null, error: message.slice(0, 300) };
        }
      }
    )
  );

  return {
    serviceAccountEmail: creds.client_email ?? null,
    serviceAccountClientId: creds.client_id ?? null,
    probes,
  };
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

  const creds = readServiceAccount(tenant);

  // Run scope checks in parallel — Google's OAuth endpoint handles the
  // concurrency fine and the operator gets results in one round-trip's
  // worth of wall time rather than N.
  const results = await Promise.all(
    REQUIRED_SCOPES.map(async ({ scope, label, feature }) => {
      try {
        await mintToken(creds, tenant.adminEmail, scope);
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
  // Keyed by what the check depends on, not only by tenant: pointing a
  // tenant at another key file or admin used to show the old key's result
  // until the cache ran out.
  const key = `${tenant.id}|${tenant.credentialsFile}|${tenant.adminEmail.toLowerCase()}`;
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
