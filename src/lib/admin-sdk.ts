import {
  google,
  type drive_v3,
  type admin_directory_v1,
  type admin_datatransfer_v1,
  type admin_reports_v1,
} from "googleapis";
import { readFileSync, statSync } from "fs";
import type { Tenant } from "./tenant-types";
import {
  isValidEmail,
  isValidDomain,
  isValidUsername,
  emailDomain,
} from "./validate";

export function buildGmailClient(tenant: Tenant | null, impersonateEmail: string, scopes: string[]) {
  const auth = buildAuth(tenant, impersonateEmail, scopes);
  return google.gmail({ version: "v1", auth });
}

export function buildCalendarClient(tenant: Tenant | null, impersonateEmail: string) {
  const auth = buildAuth(tenant, impersonateEmail, [
    "https://www.googleapis.com/auth/calendar",
  ]);
  return google.calendar({ version: "v3", auth });
}

const ADMIN_API_TIMEOUT_MS = 30_000;

// Set a default per-request timeout on EVERY googleapis call. gaxios ships with
// no default, so a stalled TLS connection to Google (mid-handshake blackhole,
// dropped keepalive) would otherwise hang a handler forever — the failure mode
// that lets an offboarding step spin indefinitely. Calls that need longer
// (mailbox raw fetches) pass an explicit per-call `timeout`, which overrides
// this floor. This covers the Gmail/Calendar settings + ACL calls that route
// handlers make directly, which previously had no timeout at all.
google.options({ timeout: ADMIN_API_TIMEOUT_MS });

const SCOPES = {
  USER: "https://www.googleapis.com/auth/admin.directory.user",
  USER_SECURITY:
    "https://www.googleapis.com/auth/admin.directory.user.security",
  DOMAIN_READONLY:
    "https://www.googleapis.com/auth/admin.directory.domain.readonly",
  GROUP: "https://www.googleapis.com/auth/admin.directory.group",
  REPORTS_AUDIT_READONLY:
    "https://www.googleapis.com/auth/admin.reports.audit.readonly",
  DATA_TRANSFER: "https://www.googleapis.com/auth/admin.datatransfer",
  DRIVE_METADATA_READONLY:
    "https://www.googleapis.com/auth/drive.metadata.readonly",
  // Required to delete permissions. Google Drive does not expose a narrower
  // scope for permission management — `drive.file` only covers files the app
  // itself created, which doesn't help an admin tool acting on existing files.
  DRIVE_FULL: "https://www.googleapis.com/auth/drive",
} as const;

interface ServiceAccountCreds {
  client_email?: string;
  private_key?: string;
}

/**
 * Cache parsed service-account credentials keyed by file path. Every client
 * construction used to re-read and re-parse the key file synchronously — a
 * blocking disk read on the request path repeated for each paginated call. A
 * cheap stat avoids the full read+parse on every call.
 *
 * Invalidation triggers on any of: mtime change, size change, or the entry
 * aging past the TTL. mtime alone is too weak — a key rotation that preserves
 * the timestamp (cp -p, restore-from-backup, mtime-preserving deploy, or a
 * coarse-resolution filesystem) would otherwise serve a revoked key until the
 * process restarts. The size check catches the common rotation case at once,
 * and the TTL bounds worst-case staleness even if mtime and size both happen
 * to match. The TTL is long enough that a paginated walk still reuses the
 * cache rather than re-reading per page.
 */
const CREDS_CACHE_TTL_MS = 30_000;

interface CredsCacheEntry {
  mtimeMs: number;
  size: number;
  loadedAt: number;
  creds: ServiceAccountCreds;
}

const credsCache = new Map<string, CredsCacheEntry>();

function loadCredentials(credFile: string): ServiceAccountCreds {
  const stat = statSync(credFile);
  const cached = credsCache.get(credFile);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    Date.now() - cached.loadedAt < CREDS_CACHE_TTL_MS
  ) {
    return cached.creds;
  }
  const creds = JSON.parse(readFileSync(credFile, "utf-8")) as ServiceAccountCreds;
  credsCache.set(credFile, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    loadedAt: Date.now(),
    creds,
  });
  return creds;
}

/**
 * Build a JWT auth client for a tenant.
 *
 * `subject` is the principal we impersonate via domain-wide delegation:
 *   - For Admin SDK calls, this MUST be a super admin (defaults to the
 *     tenant's adminEmail).
 *   - For Drive calls run "as" a specific user, pass that user's email.
 *
 * The service account in your tenant must be authorised in the Admin Console
 * for every scope listed in `scopes`.
 */
/**
 * Cache built JWT clients. google-auth-library caches the fetched access token
 * per JWT instance, so reusing the instance avoids a fresh signed-JWT grant
 * against Google's OAuth endpoint on every call/page (~100-250ms each). Keyed by
 * credential file + impersonated subject + scope set, and — crucially — by the
 * file's mtime/size so a key rotation produces a new instance rather than
 * serving a stale (possibly revoked) token for the life of the process.
 */
const JWT_CACHE_MAX = 100;
const jwtCache = new Map<string, InstanceType<typeof google.auth.JWT>>();

function buildAuth(tenant: Tenant | null, subject: string, scopes: string[]) {
  const credFile =
    tenant?.credentialsFile ||
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;

  if (!credFile) {
    throw new Error(
      "No credentials configured. Add a tenant on the Tenants page or set " +
        "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE."
    );
  }

  const stat = statSync(credFile);
  const cacheKey = `${credFile}|${subject.toLowerCase()}|${[...scopes]
    .sort()
    .join(",")}|${stat.mtimeMs}|${stat.size}`;
  const cached = jwtCache.get(cacheKey);
  if (cached) {
    // Touch for recency: Map iterates in insertion order, so re-inserting on
    // every hit makes the size-cap eviction below LRU instead of FIFO. Without
    // this, a long per-user impersonation sweep (sharing audit) evicts the hot
    // admin JWT and every Admin SDK call pays a fresh token grant.
    jwtCache.delete(cacheKey);
    jwtCache.set(cacheKey, cached);
    return cached;
  }

  const creds = loadCredentials(credFile);
  const jwt = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes,
    subject,
  });
  // Bound the cache. A rotation or new subject/scope set adds keys; evict the
  // oldest insertion when we exceed the cap so it can't grow without limit.
  if (jwtCache.size >= JWT_CACHE_MAX) {
    const oldest = jwtCache.keys().next().value;
    if (oldest !== undefined) jwtCache.delete(oldest);
  }
  jwtCache.set(cacheKey, jwt);
  return jwt;
}

function impersonatedAdminFor(tenant: Tenant | null, override?: string): string {
  const subject =
    override || tenant?.adminEmail || process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL;
  if (!subject) {
    throw new Error(
      "No admin email configured for impersonation. Set one on the tenant or as GOOGLE_WORKSPACE_ADMIN_EMAIL."
    );
  }
  return subject;
}

/**
 * Admin SDK Directory client (impersonating the tenant admin).
 * Includes user.security scope so we can manage OAuth tokens and sign-out.
 */
function getAdminClient(
  tenant: Tenant | null,
  adminEmail?: string
): { client: admin_directory_v1.Admin; impersonatedAdmin: string } {
  const subject = impersonatedAdminFor(tenant, adminEmail);
  const auth = buildAuth(tenant, subject, [
    SCOPES.USER,
    SCOPES.USER_SECURITY,
    SCOPES.DOMAIN_READONLY,
  ]);
  return {
    client: google.admin({ version: "directory_v1", auth }),
    impersonatedAdmin: subject.toLowerCase(),
  };
}

/**
 * Admin SDK Directory client scoped to groups only (impersonating the tenant
 * admin). Kept separate from getAdminClient on purpose: a JWT requests its
 * whole scope set in every token grant and domain-wide delegation evaluates
 * that set as a unit, so folding the groups scope into the shared client
 * would break every existing directory call for tenants that haven't
 * authorised the new scope yet.
 */
function getGroupsClient(
  tenant: Tenant | null,
  adminEmail?: string
): { client: admin_directory_v1.Admin; impersonatedAdmin: string } {
  const subject = impersonatedAdminFor(tenant, adminEmail);
  const auth = buildAuth(tenant, subject, [SCOPES.GROUP]);
  return {
    client: google.admin({ version: "directory_v1", auth }),
    impersonatedAdmin: subject.toLowerCase(),
  };
}

/**
 * Admin SDK Reports client (impersonating the tenant admin). Scope-isolated
 * for the same domain-wide-delegation reason as getGroupsClient: tenants that
 * haven't authorised the reports scope must keep every existing feature
 * working.
 */
function getReportsClient(
  tenant: Tenant | null,
  adminEmail?: string
): { client: admin_reports_v1.Admin; impersonatedAdmin: string } {
  const subject = impersonatedAdminFor(tenant, adminEmail);
  const auth = buildAuth(tenant, subject, [SCOPES.REPORTS_AUDIT_READONLY]);
  return {
    client: google.admin({ version: "reports_v1", auth }),
    impersonatedAdmin: subject.toLowerCase(),
  };
}

/** Admin SDK Data Transfer client (impersonating the tenant admin). */
function getDataTransferClient(
  tenant: Tenant | null
): admin_datatransfer_v1.Admin {
  const subject = impersonatedAdminFor(tenant);
  const auth = buildAuth(tenant, subject, [SCOPES.DATA_TRANSFER]);
  return google.admin({ version: "datatransfer_v1", auth });
}

/**
 * Drive client run AS a specific user (not as the admin).
 *
 * For sharing audits we impersonate the user whose Drive we're listing —
 * domain-wide delegation lets a service account act as any user provided the
 * scope is authorised. We use the metadata-readonly scope so a compromised
 * audit can't be used to read file contents.
 */
function getDriveClient(tenant: Tenant | null, asUser: string): drive_v3.Drive {
  if (!isValidEmail(asUser)) {
    throw new Error("asUser must be a valid email address");
  }
  const auth = buildAuth(tenant, asUser, [SCOPES.DRIVE_METADATA_READONLY]);
  return google.drive({ version: "v3", auth });
}

/**
 * Drive client run AS a specific user with write access. Used by the external
 * sharing remediation flow to call permissions.delete — there is no
 * narrower scope for that operation.
 */
function getDriveClientWritable(
  tenant: Tenant | null,
  asUser: string
): drive_v3.Drive {
  if (!isValidEmail(asUser)) {
    throw new Error("asUser must be a valid email address");
  }
  const auth = buildAuth(tenant, asUser, [SCOPES.DRIVE_FULL]);
  return google.drive({ version: "v3", auth });
}

/**
 * Drive client run AS the tenant admin with the full Drive scope. Used as a
 * second-attempt fallback when a user-scoped permission delete is rejected
 * because the permission is inherited from a Shared Drive — domain admins
 * with the `useDomainAdminAccess: true` parameter can override the
 * inheritance restriction. See:
 * https://developers.google.com/workspace/drive/api/guides/limited-expansive-access
 */
function getDriveClientAsAdmin(tenant: Tenant | null): drive_v3.Drive {
  const subject = impersonatedAdminFor(tenant);
  const auth = buildAuth(tenant, subject, [SCOPES.DRIVE_FULL]);
  return google.drive({ version: "v3", auth });
}

export interface UserInfo {
  primaryEmail: string;
  name: {
    fullName: string;
    givenName: string;
    familyName: string;
  };
  emails: Array<{
    address: string;
    primary?: boolean;
    type?: string;
  }>;
  orgUnitPath: string;
  isAdmin: boolean;
  suspended: boolean;
}

export interface DomainInfo {
  domainName: string;
  isPrimary: boolean;
  verified: boolean;
}

/** Look up a user by their email address. */
export async function getUser(
  tenant: Tenant | null,
  userEmail: string
): Promise<UserInfo> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }
  const { client } = getAdminClient(tenant);
  const res = await withGoogleRetry(
    () =>
      client.users.get(
        { userKey: userEmail, projection: "full" },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );

  const user = res.data;
  return {
    primaryEmail: user.primaryEmail || "",
    name: {
      fullName: user.name?.fullName || "",
      givenName: user.name?.givenName || "",
      familyName: user.name?.familyName || "",
    },
    emails: (user.emails as UserInfo["emails"]) || [],
    orgUnitPath: user.orgUnitPath || "/",
    isAdmin: user.isAdmin || false,
    suspended: user.suspended || false,
  };
}

/**
 * Check whether an email address already belongs to a user in the tenant.
 * Returns true if the lookup succeeds, false if Google returns 404, throws
 * for any other error so we never silently treat "we don't know" as "free".
 */
export async function userExists(
  tenant: Tenant | null,
  email: string
): Promise<boolean> {
  if (!isValidEmail(email)) {
    throw new Error("email must be a valid email address");
  }
  const { client } = getAdminClient(tenant);
  try {
    await withGoogleRetry(
      () =>
        client.users.get(
          { userKey: email, projection: "basic", fields: "primaryEmail" },
          { timeout: ADMIN_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    );
    return true;
  } catch (e: unknown) {
    if (isNotFoundError(e)) return false;
    throw e;
  }
}

/**
 * Short-TTL cache for the tenant's domain list. Chunked flows (drive-transfer
 * continuations, revoke batches, tenant-wide audits) re-derive the verified
 * set on every request, gating each chunk behind an extra serial round trip to
 * Google. Domain verification changes on the order of days, so a 60s window is
 * safe; only successful fetches are cached, and the key includes the
 * credentials + admin identity so editing a tenant can't serve another
 * tenant's domains.
 */
const DOMAINS_CACHE_TTL_MS = 60_000;
const DOMAINS_CACHE_MAX = 100;
const domainsCache = new Map<string, { at: number; domains: DomainInfo[] }>();

/** List all domains in the Google Workspace tenant. */
export async function listDomains(
  tenant: Tenant | null
): Promise<DomainInfo[]> {
  const cacheKey = `${tenant?.id ?? "env"}|${tenant?.credentialsFile ?? ""}|${
    tenant?.adminEmail ?? ""
  }`;
  const cached = domainsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DOMAINS_CACHE_TTL_MS) {
    return cached.domains;
  }

  const { client } = getAdminClient(tenant);
  const res = await withGoogleRetry(
    () =>
      client.domains.list(
        { customer: "my_customer" },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );

  const domains = (res.data.domains || []).map((d) => ({
    domainName: (d.domainName || "").toLowerCase(),
    isPrimary: d.isPrimary || false,
    verified: d.verified || false,
  }));
  if (domainsCache.size >= DOMAINS_CACHE_MAX) {
    const oldest = domainsCache.keys().next().value;
    if (oldest !== undefined) domainsCache.delete(oldest);
  }
  domainsCache.set(cacheKey, { at: Date.now(), domains });
  return domains;
}

/**
 * Whether `email`'s domain is NOT one of the tenant's verified domains — i.e.
 * granting access/forwarding to it sends data outside the org. Fails CLOSED
 * (treats the target as external) when domains can't be enumerated, so a
 * transient error can't silently downgrade an external target to "internal" and
 * skip the confirmation gate. Shared by every flow that hands data to a target
 * user (email forwarding, calendar ownership, offboarding successor) so the
 * external-target rule can't drift between them.
 */
export async function isExternalTarget(
  tenant: Tenant | null,
  email: string
): Promise<boolean> {
  try {
    const verified = new Set(
      (await listDomains(tenant))
        .filter((d) => d.verified)
        .map((d) => d.domainName)
    );
    return !verified.has(emailDomain(email));
  } catch {
    return true;
  }
}

export interface ListedUser {
  primaryEmail: string;
  fullName: string;
  isAdmin: boolean;
  suspended: boolean;
  orgUnitPath: string;
}

/**
 * Page through all users in the tenant. Caller passes a pageToken from a
 * previous call to advance. Caps page size at 500 (Google's max for this
 * call) and asks only for the fields we need so even very small tenants get
 * snappy responses.
 *
 * The tenant-wide sharing audit walks every page; for very large tenants
 * the caller should reuse pagination or chunk by orgUnit.
 */
export async function listUsers(
  tenant: Tenant | null,
  opts: { pageToken?: string; pageSize?: number } = {}
): Promise<{ users: ListedUser[]; nextPageToken: string | null }> {
  const { client } = getAdminClient(tenant);
  const res = await withGoogleRetry(
    () =>
      client.users.list(
        {
          customer: "my_customer",
          maxResults: Math.min(500, Math.max(1, opts.pageSize ?? 500)),
          pageToken: opts.pageToken,
          orderBy: "email",
          projection: "basic",
          // Trim payload — we only care about who exists and basic status.
          fields:
            "nextPageToken, users(primaryEmail, name/fullName, isAdmin, suspended, orgUnitPath)",
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );

  const users: ListedUser[] = (res.data.users || []).map((u) => ({
    primaryEmail: (u.primaryEmail || "").toLowerCase(),
    fullName: u.name?.fullName || "",
    isAdmin: u.isAdmin || false,
    suspended: u.suspended || false,
    orgUnitPath: u.orgUnitPath || "/",
  }));

  return { users, nextPageToken: res.data.nextPageToken || null };
}

/**
 * Change a user's primary domain. (Preflight + read-after-write — see the
 * domain-change route handler for the full safety story.)
 */
export async function changePrimaryDomain(
  tenant: Tenant | null,
  currentEmail: string,
  newDomain: string,
  newUsername?: string
): Promise<{
  previousEmail: string;
  newEmail: string;
  verifiedNewPrimary: string;
}> {
  if (!isValidEmail(currentEmail)) {
    throw new Error("currentEmail must be a valid email address");
  }
  if (!isValidDomain(newDomain)) {
    throw new Error("newDomain must be a valid domain");
  }
  if (newUsername !== undefined && newUsername !== "" && !isValidUsername(newUsername)) {
    throw new Error("newUsername contains invalid characters");
  }

  const { client, impersonatedAdmin } = getAdminClient(tenant);

  const username = newUsername || currentEmail.split("@")[0];
  const newEmail = `${username}@${newDomain}`.toLowerCase();
  const currentLower = currentEmail.toLowerCase();

  if (newEmail === currentLower) {
    throw new Error("New email is the same as the current email");
  }
  if (currentLower === impersonatedAdmin) {
    throw new Error(
      "Refusing to change the primary email of the admin account this tool is impersonating — that would break subsequent admin operations. Use the Google Admin Console for this change."
    );
  }

  const domains = await listDomains(tenant);
  const targetDomain = domains.find(
    (d) => d.domainName === newDomain.toLowerCase()
  );
  if (!targetDomain) {
    throw new Error(`Domain "${newDomain}" is not configured in this tenant`);
  }
  if (!targetDomain.verified) {
    throw new Error(`Domain "${newDomain}" is not verified — refusing to change primary email to an unverified domain`);
  }

  // `userKey` resolves aliases to the same account, so the string compare above
  // can miss an alias of the admin. Resolve the canonical record: it doubles as
  // the existence check and lets us re-check the real primary email.
  let targetInfo: UserInfo;
  try {
    targetInfo = await getUser(tenant, currentEmail);
  } catch (e) {
    if (isNotFoundError(e)) {
      throw new Error(`No user found with email "${currentEmail}"`);
    }
    throw e;
  }
  if (targetInfo.primaryEmail.toLowerCase() === impersonatedAdmin) {
    throw new Error(
      "Refusing to change the primary email of the admin account this tool is impersonating — that would break subsequent admin operations. Use the Google Admin Console for this change."
    );
  }

  // `userKey` resolves aliases, so a plain existence check would also match
  // the target user's OWN alias on the new domain — a case Google happily
  // accepts for a primary-email change (the alias is promoted). Only treat
  // the address as taken when it resolves to a DIFFERENT account.
  let conflictOwner: string | null = null;
  try {
    const res = await withGoogleRetry(
      () =>
        client.users.get(
          { userKey: newEmail, projection: "basic", fields: "primaryEmail" },
          { timeout: ADMIN_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    );
    conflictOwner = (res.data.primaryEmail || "").toLowerCase();
  } catch (e) {
    if (!isNotFoundError(e)) throw e;
  }
  if (
    conflictOwner !== null &&
    conflictOwner !== targetInfo.primaryEmail.toLowerCase()
  ) {
    throw new Error(
      `"${newEmail}" is already in use by another user. Pick a different username or domain.`
    );
  }

  // 429-only retry: a rate-limited rename never reached Google's store, so
  // backing off is safe, while a 5xx might have committed the rename and a
  // blind retry would then fail confusingly on the old userKey.
  await withGoogleRetry(
    () =>
      client.users.update(
        {
          userKey: currentEmail,
          requestBody: { primaryEmail: newEmail },
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: false }
  );

  // Retry the read-after-write verification: the rename above has already
  // committed, so failing here on a transient blip would report a successful
  // change as failed — and a re-run then dead-ends on a confusing
  // "already in use" conflict for the new address.
  const after = await withGoogleRetry(
    () =>
      client.users.get(
        {
          userKey: newEmail,
          projection: "basic",
          fields: "primaryEmail",
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );

  return {
    previousEmail: currentLower,
    newEmail,
    verifiedNewPrimary: (after.data.primaryEmail || "").toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Offboarding primitives
// ---------------------------------------------------------------------------

/** Suspend a user. Refuses to suspend the impersonated admin themselves. */
export async function suspendUser(
  tenant: Tenant | null,
  userEmail: string
): Promise<void> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }
  const { client, impersonatedAdmin } = getAdminClient(tenant);
  if (userEmail.toLowerCase() === impersonatedAdmin) {
    throw new Error(
      "Refusing to suspend the admin this tool is impersonating — would lock Open Admin out."
    );
  }
  // `userKey` accepts aliases and resolves them to the same account, so resolve
  // the canonical primary email before suspending: an alias of the admin would
  // otherwise slip past the string compare above and lock Open Admin out.
  const target = await getUser(tenant, userEmail);
  if (target.primaryEmail.toLowerCase() === impersonatedAdmin) {
    throw new Error(
      "Refusing to suspend the admin this tool is impersonating — would lock Open Admin out."
    );
  }
  await withGoogleRetry(
    () =>
      client.users.update(
        {
          userKey: userEmail,
          requestBody: { suspended: true },
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );
}

/**
 * Sign the user out of all sessions. Per the Admin SDK this also invalidates
 * their session cookies; OAuth tokens are revoked separately.
 */
export async function signOutAllSessions(
  tenant: Tenant | null,
  userEmail: string
): Promise<void> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }
  const { client } = getAdminClient(tenant);
  await withGoogleRetry(
    () =>
      client.users.signOut(
        { userKey: userEmail },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );
}

/**
 * List the OAuth tokens a user has issued to third-party apps.
 * Useful for both the offboarding preview ("we'll revoke 7 tokens") and the
 * audit page.
 */
export async function listOAuthTokens(
  tenant: Tenant | null,
  userEmail: string
): Promise<Array<{ clientId: string; displayText: string; scopes: string[] }>> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }
  const { client } = getAdminClient(tenant);
  const res = await withGoogleRetry(
    () =>
      client.tokens.list(
        { userKey: userEmail },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );
  return (res.data.items || []).map((t) => ({
    clientId: t.clientId || "",
    displayText: t.displayText || t.clientId || "(unknown)",
    scopes: t.scopes || [],
  }));
}

/** Revoke every OAuth token the user has granted to third-party apps. */
export async function revokeAllOAuthTokens(
  tenant: Tenant | null,
  userEmail: string
): Promise<{
  revoked: number;
  failed: number;
  errors: Array<{ clientId: string; message: string }>;
}> {
  const tokens = await listOAuthTokens(tenant, userEmail);
  if (tokens.length === 0) return { revoked: 0, failed: 0, errors: [] };
  const { client } = getAdminClient(tenant);
  let revoked = 0;
  let failed = 0;
  const errors: Array<{ clientId: string; message: string }> = [];
  // Delete with bounded concurrency: each revoke is an independent, idempotent
  // delete, so a serial walk just multiplies the offboarding step's latency by
  // the token count. 5 in flight stays far under Admin SDK quotas while the
  // retry layer absorbs the occasional 429.
  const REVOKE_TOKEN_CONCURRENCY = 5;
  let cursor = 0;
  const worker = async () => {
    while (cursor < tokens.length) {
      const t = tokens[cursor++];
      try {
        await withGoogleRetry(
          () =>
            client.tokens.delete(
              { userKey: userEmail, clientId: t.clientId },
              { timeout: ADMIN_API_TIMEOUT_MS }
            ),
          { retryServerErrors: true }
        );
        revoked++;
      } catch (e) {
        failed++;
        // Keep the reason: "3 tokens failed to revoke" is undiagnosable without it.
        errors.push({
          clientId: t.clientId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(REVOKE_TOKEN_CONCURRENCY, tokens.length) },
      worker
    )
  );
  return { revoked, failed, errors };
}

export interface GroupSummary {
  id: string;
  email: string;
  name: string;
  description: string;
  directMembersCount: string;
}

export interface GroupMember {
  id: string;
  email: string;
  role: string;
  type: string;
  status: string;
}

export const GROUP_MEMBER_ROLES = ["MEMBER", "MANAGER", "OWNER"] as const;
export type GroupMemberRole = (typeof GROUP_MEMBER_ROLES)[number];

// groups.list and members.list cap maxResults at 200 (lower than the 500 the
// users call allows).
const GROUPS_MAX_PAGE_SIZE = 200;

/**
 * Page through groups. Two modes:
 *   - customer mode (default): every group in the tenant, optionally narrowed
 *     by a Directory API `query` (e.g. `email:eng-*`).
 *   - userKey mode: only the groups that user/group is a direct member of.
 * The API rejects `query` alongside `userKey`, so we do too, up front.
 */
export async function listGroups(
  tenant: Tenant | null,
  opts: {
    pageToken?: string;
    pageSize?: number;
    query?: string;
    userKey?: string;
  } = {}
): Promise<{ groups: GroupSummary[]; nextPageToken: string | null }> {
  if (opts.userKey && opts.query) {
    throw new Error("query cannot be combined with userKey");
  }
  if (opts.userKey && !isValidEmail(opts.userKey)) {
    throw new Error("userKey must be a valid email address");
  }
  const { client } = getGroupsClient(tenant);
  const maxResults = Math.min(
    GROUPS_MAX_PAGE_SIZE,
    Math.max(1, opts.pageSize ?? GROUPS_MAX_PAGE_SIZE)
  );
  const res = await withGoogleRetry(
    () =>
      client.groups.list(
        {
          ...(opts.userKey
            ? { userKey: opts.userKey }
            : { customer: "my_customer", query: opts.query || undefined }),
          maxResults,
          pageToken: opts.pageToken,
          fields:
            "nextPageToken, groups(id, email, name, description, directMembersCount)",
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );

  const groups: GroupSummary[] = (res.data.groups || []).map((g) => ({
    id: g.id || "",
    email: (g.email || "").toLowerCase(),
    name: g.name || "",
    description: g.description || "",
    directMembersCount: String(g.directMembersCount ?? ""),
  }));
  return { groups, nextPageToken: res.data.nextPageToken || null };
}

/** Page through the direct members of a group. */
export async function listGroupMembers(
  tenant: Tenant | null,
  groupKey: string,
  opts: { pageToken?: string; pageSize?: number } = {}
): Promise<{ members: GroupMember[]; nextPageToken: string | null }> {
  if (!isValidEmail(groupKey)) {
    throw new Error("groupKey must be a valid email address");
  }
  const { client } = getGroupsClient(tenant);
  const res = await withGoogleRetry(
    () =>
      client.members.list(
        {
          groupKey,
          maxResults: Math.min(
            GROUPS_MAX_PAGE_SIZE,
            Math.max(1, opts.pageSize ?? GROUPS_MAX_PAGE_SIZE)
          ),
          pageToken: opts.pageToken,
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );

  const members: GroupMember[] = (res.data.members || []).map((m) => ({
    id: m.id || "",
    email: (m.email || "").toLowerCase(),
    role: m.role || "MEMBER",
    type: m.type || "",
    status: m.status || "",
  }));
  return { members, nextPageToken: res.data.nextPageToken || null };
}

/**
 * Add a member to a group. An existing membership is treated as success
 * (retry-safe, like forwarding-address creation) — the caller learns which
 * via `alreadyMember`. No retryServerErrors: the insert is not idempotent
 * from the API's point of view, and the ambiguity of a timed-out insert is
 * exactly what the alreadyMember tolerance absorbs on re-run.
 *
 * When the member already exists, Google rejects the insert and leaves their
 * CURRENT role untouched — so "add X as MANAGER" would silently no-op on an
 * existing MEMBER. Pass `enforceRole: true` (callers set it when the role was
 * explicitly chosen) to converge on the requested role via members.update.
 * It stays off for defaulted roles so a bare re-add can never silently demote
 * an existing OWNER to MEMBER.
 */
export async function addGroupMember(
  tenant: Tenant | null,
  groupKey: string,
  memberEmail: string,
  role: GroupMemberRole,
  opts: { enforceRole?: boolean } = {}
): Promise<{ alreadyMember: boolean; previousRole?: string; roleChanged?: boolean }> {
  if (!isValidEmail(groupKey)) {
    throw new Error("groupKey must be a valid email address");
  }
  if (!isValidEmail(memberEmail)) {
    throw new Error("memberEmail must be a valid email address");
  }
  const { client } = getGroupsClient(tenant);
  try {
    await withGoogleRetry(
      () =>
        client.members.insert(
          {
            groupKey,
            requestBody: { email: memberEmail, role },
          },
          { timeout: ADMIN_API_TIMEOUT_MS }
        ),
      { retryServerErrors: false }
    );
    return { alreadyMember: false };
  } catch (e) {
    if (!isAlreadyExistsError(e)) throw e;
    if (!opts.enforceRole) return { alreadyMember: true };
    const existing = await withGoogleRetry(
      () =>
        client.members.get(
          { groupKey, memberKey: memberEmail },
          { timeout: ADMIN_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    );
    const currentRole = (existing.data.role || "MEMBER").toUpperCase();
    if (currentRole === role) {
      return { alreadyMember: true, previousRole: currentRole, roleChanged: false };
    }
    // Role update is idempotent, so 5xx retries are safe here.
    await withGoogleRetry(
      () =>
        client.members.update(
          {
            groupKey,
            memberKey: memberEmail,
            requestBody: { role },
          },
          { timeout: ADMIN_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    );
    return { alreadyMember: true, previousRole: currentRole, roleChanged: true };
  }
}

/**
 * Remove a member from a group. A missing membership is not an error —
 * `removed: false` tells the caller it was already gone (idempotent re-runs).
 * A 404 for the GROUP itself (typo'd address) is disambiguated from a missing
 * membership and surfaced as an error — "already removed" for a group that
 * never existed would mislead the operator into thinking the removal took.
 */
export async function removeGroupMember(
  tenant: Tenant | null,
  groupKey: string,
  memberEmail: string
): Promise<{ removed: boolean }> {
  if (!isValidEmail(groupKey)) {
    throw new Error("groupKey must be a valid email address");
  }
  if (!isValidEmail(memberEmail)) {
    throw new Error("memberEmail must be a valid email address");
  }
  const { client } = getGroupsClient(tenant);
  try {
    await withGoogleRetry(
      () =>
        client.members.delete(
          { groupKey, memberKey: memberEmail },
          { timeout: ADMIN_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    );
    return { removed: true };
  } catch (e) {
    if (!isNotFoundError(e)) throw e;
    // The delete's 404 doesn't say WHICH resource was missing. Check the
    // group: if it's gone too, this was a bad group address, not an
    // already-removed membership. Any error in the check itself degrades to
    // the historical "already gone" answer rather than failing the call.
    try {
      await withGoogleRetry(
        () =>
          client.groups.get(
            { groupKey, fields: "id" },
            { timeout: ADMIN_API_TIMEOUT_MS }
          ),
        { retryServerErrors: true }
      );
    } catch (ge) {
      if (isNotFoundError(ge)) {
        throw new Error(`Group "${groupKey}" was not found`);
      }
      return { removed: false };
    }
    return { removed: false };
  }
}

/**
 * Remove a user from every group they are a direct member of. Used by the
 * offboarding "groups" step. Enumerates memberships first, then deletes with
 * bounded concurrency (same shape as revokeAllOAuthTokens). A 404 during
 * removal counts as removed so a re-run after partial failure converges.
 */
export async function removeUserFromAllGroups(
  tenant: Tenant | null,
  userEmail: string
): Promise<{
  removed: number;
  failed: number;
  errors: Array<{ group: string; message: string }>;
  /**
   * True when the user belonged to more groups than the per-run cap — some
   * memberships remain and the caller must re-run (or report a partial
   * result) instead of treating the step as complete.
   */
  truncated: boolean;
}> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }

  // Enumerate every membership up front. Bounded so a pathological tenant
  // (or a groups-of-groups explosion) can't spin this step forever.
  const MAX_GROUPS = 2000;
  const memberships: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listGroups(tenant, { userKey: userEmail, pageToken });
    for (const g of page.groups) {
      if (g.email) memberships.push(g.email);
    }
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken && memberships.length < MAX_GROUPS);
  const truncated = pageToken !== undefined || memberships.length > MAX_GROUPS;
  if (memberships.length > MAX_GROUPS) memberships.length = MAX_GROUPS;

  if (memberships.length === 0) {
    return { removed: 0, failed: 0, errors: [], truncated };
  }

  const { client } = getGroupsClient(tenant);
  let removed = 0;
  let failed = 0;
  const errors: Array<{ group: string; message: string }> = [];
  const REMOVE_CONCURRENCY = 5;
  let cursor = 0;
  const worker = async () => {
    while (cursor < memberships.length) {
      const group = memberships[cursor++];
      try {
        await withGoogleRetry(
          () =>
            client.members.delete(
              { groupKey: group, memberKey: userEmail },
              { timeout: ADMIN_API_TIMEOUT_MS }
            ),
          { retryServerErrors: true }
        );
        removed++;
      } catch (e) {
        if (isNotFoundError(e)) {
          // Already gone (racing admin, previous partial run) — that's the goal.
          removed++;
          continue;
        }
        failed++;
        errors.push({
          group,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(REMOVE_CONCURRENCY, memberships.length) },
      worker
    )
  );
  return { removed, failed, errors, truncated };
}

export interface ActivityEvent {
  /** RFC3339 timestamp of the activity. */
  time: string;
  actor: string;
  ip: string | null;
  eventType: string;
  eventName: string;
  params?: Record<string, string>;
}

const ACTIVITY_MAX_RESULTS = 1000;
// Bound the flattened parameter payload per event: values feed AI prompts and
// JSON responses, and a single admin event can carry arbitrarily long strings.
const ACTIVITY_MAX_PARAMS = 20;
const ACTIVITY_PARAM_VALUE_MAX = 200;

/**
 * Page through Reports API audit activities for one application. Returns one
 * flattened event per (activity item × nested event) — a single sign-in item
 * can carry several events (e.g. login_success + login_challenge) and
 * flattening keeps rows independently filterable and exportable.
 *
 * Note Google's Reports data is not real-time: login events can lag from a
 * few minutes to hours.
 */
export async function listActivityEvents(
  tenant: Tenant | null,
  opts: {
    app: "login" | "admin";
    /** Restrict to one user's activity; omit for everyone. */
    userKey?: string;
    /** RFC3339 lower bound. */
    startTime: string;
    pageToken?: string;
    maxResults?: number;
  }
): Promise<{ events: ActivityEvent[]; nextPageToken: string | null }> {
  if (opts.userKey && !isValidEmail(opts.userKey)) {
    throw new Error("userKey must be a valid email address");
  }
  const { client } = getReportsClient(tenant);
  const res = await withGoogleRetry(
    () =>
      client.activities.list(
        {
          userKey: opts.userKey ?? "all",
          applicationName: opts.app,
          startTime: opts.startTime,
          maxResults: Math.min(
            ACTIVITY_MAX_RESULTS,
            Math.max(1, opts.maxResults ?? ACTIVITY_MAX_RESULTS)
          ),
          pageToken: opts.pageToken,
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );

  const events: ActivityEvent[] = [];
  for (const item of res.data.items || []) {
    const time = item.id?.time || "";
    const actor = item.actor?.email || item.actor?.callerType || "(unknown)";
    const ip = item.ipAddress ?? null;
    for (const ev of item.events || []) {
      let params: Record<string, string> | undefined;
      if (ev.parameters && ev.parameters.length > 0) {
        params = {};
        for (const p of ev.parameters.slice(0, ACTIVITY_MAX_PARAMS)) {
          if (!p.name) continue;
          const value =
            p.value ??
            (p.boolValue !== undefined && p.boolValue !== null
              ? String(p.boolValue)
              : p.intValue !== undefined && p.intValue !== null
                ? String(p.intValue)
                : p.multiValue
                  ? p.multiValue.join(", ")
                  : "");
          params[p.name] = String(value).slice(0, ACTIVITY_PARAM_VALUE_MAX);
        }
      }
      events.push({
        time,
        actor,
        ip,
        eventType: ev.type || "",
        eventName: ev.name || "",
        ...(params && Object.keys(params).length > 0 ? { params } : {}),
      });
    }
  }
  return { events, nextPageToken: res.data.nextPageToken || null };
}

/**
 * Resolve the numeric application ID for "Drive and Docs" in the Data Transfer
 * API.
 *
 * Google does not publish a value that's safe to hardcode — the documented way
 * to obtain it is `applications.list`, and a stale/guessed id surfaces only at
 * transfer time as the opaque "Application Id not found" error. The id is a
 * Google-global constant (identical across customers), so we memoise it after
 * the first successful lookup.
 *
 * https://developers.google.com/admin-sdk/data-transfer/v1/transfer-data
 */
let cachedDriveAppId: string | null = null;

async function resolveDriveAppId(
  transfer: admin_datatransfer_v1.Admin
): Promise<string> {
  if (cachedDriveAppId) return cachedDriveAppId;

  const res = await withGoogleRetry(
    () =>
      transfer.applications.list(
        { customerId: "my_customer" },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );
  const apps = res.data.applications || [];
  // Match by name, preferring an exact "Drive and Docs" but tolerating a minor
  // relabel (case/wording) so the transfer doesn't break on a cosmetic change.
  const drive =
    apps.find((a) => (a.name || "").trim().toLowerCase() === "drive and docs") ||
    apps.find((a) => (a.name || "").toLowerCase().includes("drive"));
  if (!drive?.id) {
    throw new Error(
      "Could not find the Drive and Docs application via the Data Transfer API. " +
        "Confirm the service account is authorised for the admin.datatransfer scope."
    );
  }
  cachedDriveAppId = drive.id;
  return drive.id;
}

/**
 * Transfer all Drive items owned by `fromUser` to `toUser` using the official
 * Admin SDK Data Transfer API.
 *
 * Returns the transfer id so callers can poll status if needed. Google
 * processes these asynchronously — completion isn't guaranteed when this
 * function returns; the transfer state moves to "completed" at Google's pace.
 */
export async function transferDrive(
  tenant: Tenant | null,
  fromUser: string,
  toUser: string
): Promise<{ transferId: string }> {
  if (!isValidEmail(fromUser) || !isValidEmail(toUser)) {
    throw new Error("fromUser and toUser must be valid email addresses");
  }
  if (fromUser.toLowerCase() === toUser.toLowerCase()) {
    throw new Error("fromUser and toUser must be different");
  }

  // Look up the user IDs Google requires for the transfer call.
  const { client } = getAdminClient(tenant);
  const [fromU, toU] = await Promise.all([
    withGoogleRetry(
      () =>
        client.users.get(
          { userKey: fromUser, projection: "basic", fields: "id" },
          { timeout: ADMIN_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    ),
    withGoogleRetry(
      () =>
        client.users.get(
          { userKey: toUser, projection: "basic", fields: "id" },
          { timeout: ADMIN_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    ),
  ]);
  const fromId = fromU.data.id;
  const toId = toU.data.id;
  if (!fromId || !toId) {
    throw new Error("Could not resolve user IDs for Drive transfer");
  }

  const transfer = getDataTransferClient(tenant);
  const applicationId = await resolveDriveAppId(transfer);
  // 429-only retry: a rate-limited insert never reached Google's store, so
  // backing off is safe, while a 5xx might have registered the transfer and a
  // blind retry could duplicate it.
  const res = await withGoogleRetry(
    () =>
      transfer.transfers.insert(
        {
          requestBody: {
            oldOwnerUserId: fromId,
            newOwnerUserId: toId,
            applicationDataTransfers: [
              {
                applicationId,
                applicationTransferParams: [
                  // Transfer both private and shared items; do not release source
                  // ownership of items still required (RELEASE_RESOURCES=FALSE
                  // would leave reshare permissions; default behaviour is fine).
                  { key: "PRIVACY_LEVEL", value: ["PRIVATE", "SHARED"] },
                ],
              },
            ],
          },
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
      ),
    { retryServerErrors: false }
  );

  const id = res.data.id;
  if (!id) {
    throw new Error("Drive transfer accepted but Google did not return an id");
  }
  return { transferId: id };
}

// ---------------------------------------------------------------------------
// External sharing audit
// ---------------------------------------------------------------------------

export interface ExternalSharedFile {
  id: string;
  name: string;
  webViewLink: string | null;
  mimeType: string;
  ownedByMe: boolean;
  /** Number of permissions on this file flagged as external. */
  externalCount: number;
  external: Array<{
    type: "anyone" | "domain" | "user" | "group";
    role: string;
    /** For type=user/group, the email address. For domain, the domain. For anyone, "*". */
    target: string;
    /** Whether the link is discoverable by anyone with the link. */
    allowFileDiscovery?: boolean | null;
  }>;
}

export interface SharingAuditResult {
  user: string;
  scannedFiles: number;
  /**
   * True when more files exist beyond what this call scanned. Mirror of
   * `nextPageToken !== null`; kept for clarity in UI code that just wants
   * "did we hit the cap?".
   */
  truncated: boolean;
  /**
   * Resume token. Pass back as `pageToken` to continue from where this call
   * stopped. Null when the entire Drive has been walked.
   */
  nextPageToken: string | null;
  files: ExternalSharedFile[];
}

const SHARING_AUDIT_FILE_CAP = 1000;

/**
 * Walk a user's Drive and return every file with a permission outside the
 * tenant's verified domains.
 *
 * "External" means any of:
 *   - permission.type === "anyone" (link-shared / public)
 *   - permission.type === "domain" with a domain not in tenant's verified set
 *   - permission.type === "user" or "group" with an email outside those domains
 *
 * Caps at SHARING_AUDIT_FILE_CAP files scanned per call. Callers walking a
 * Drive larger than the cap should chain calls using the returned
 * `nextPageToken`.
 *
 * Drive metadata only — we never read file contents.
 */
export async function listExternallySharedFiles(
  tenant: Tenant | null,
  userEmail: string,
  startPageToken?: string
): Promise<SharingAuditResult> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }

  const verifiedDomains = new Set(
    (await listDomains(tenant))
      .filter((d) => d.verified)
      .map((d) => d.domainName.toLowerCase())
  );
  // Fail closed, mirroring the revoke path: with an empty verified set every
  // internal collaborator classifies as external, so the audit would flag the
  // entire Drive and invite a mass (refused, but alarming) remediation.
  if (verifiedDomains.size === 0) {
    throw new Error(
      "No verified domains resolved for this tenant — refusing to run the sharing audit, as every collaborator would be misclassified as external. Check the tenant's domain configuration and try again."
    );
  }

  const drive = getDriveClient(tenant, userEmail);

  const matches: ExternalSharedFile[] = [];
  let scanned = 0;
  let pageToken: string | undefined = startPageToken || undefined;

  // Drive truncates the inline `permissions` field on a files.list row at
  // ~100 entries with no way to paginate it. A file at that cap may hold its
  // only external grants past the cut — inline classification alone would
  // pass the file as clean. Any file at the cap gets a full permissions.list
  // walk instead; that costs extra calls only for pathologically over-shared
  // files, so the common case stays one list call per 100 files.
  const INLINE_PERMISSIONS_CAP = 100;
  const listAllPermissions = async (
    fileId: string
  ): Promise<drive_v3.Schema$Permission[]> => {
    const all: drive_v3.Schema$Permission[] = [];
    let permPageToken: string | undefined;
    do {
      const r = await withGoogleRetry(
        () =>
          drive.permissions.list(
            {
              fileId,
              fields:
                "nextPageToken, permissions(type, role, emailAddress, domain, allowFileDiscovery)",
              pageSize: 100,
              pageToken: permPageToken,
              supportsAllDrives: true,
            },
            { timeout: ADMIN_API_TIMEOUT_MS }
          ),
        { retryServerErrors: true }
      );
      all.push(...(r.data.permissions || []));
      permPageToken = r.data.nextPageToken ?? undefined;
    } while (permPageToken);
    return all;
  };

  // Belt alongside the file cap: Drive can return sparse (even empty) pages
  // while still supplying a nextPageToken, so a call bounded only by files
  // scanned could chain an unbounded number of list requests. The page bound
  // keeps one route invocation's latency predictable; anything left resumes
  // via the returned nextPageToken as usual.
  const SHARING_AUDIT_MAX_PAGES = 50;
  let pagesFetched = 0;

  while (scanned < SHARING_AUDIT_FILE_CAP && pagesFetched < SHARING_AUDIT_MAX_PAGES) {
    pagesFetched++;
    const remaining = SHARING_AUDIT_FILE_CAP - scanned;
    const res: { data: drive_v3.Schema$FileList } = await withGoogleRetry(
      () =>
        drive.files.list(
          {
            // Files the user can see — focus on shared items only to keep the
            // audit cheap. `q="visibility != 'limited'"` would miss link-shared
            // items, so we use the broader filter and check permissions client-side.
            // Files whose inline permissions hit Drive's ~100-entry cap are
            // re-listed with full pagination below so none are missed.
            q: "trashed = false and 'me' in owners",
            fields:
              "nextPageToken, files(id, name, mimeType, webViewLink, ownedByMe, permissions(type, role, emailAddress, domain, allowFileDiscovery))",
            pageSize: Math.min(100, remaining),
            pageToken,
            // Includes shared drive support so company-shared content isn't missed.
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            corpora: "user",
          },
          { timeout: ADMIN_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    );

    const files = res.data.files || [];
    for (const f of files) {
      scanned++;
      let perms = f.permissions || [];
      if (perms.length >= INLINE_PERMISSIONS_CAP && f.id) {
        try {
          perms = await listAllPermissions(f.id);
        } catch {
          // Fall back to the (possibly truncated) inline set rather than
          // failing the whole scan for one over-shared file.
        }
      }
      const externals: ExternalSharedFile["external"] = [];
      for (const p of perms) {
        const flag = classifyPermission(p, verifiedDomains);
        if (flag) externals.push(flag);
      }
      if (externals.length > 0) {
        matches.push({
          id: f.id || "",
          name: f.name || "(untitled)",
          webViewLink: f.webViewLink || null,
          mimeType: f.mimeType || "",
          ownedByMe: f.ownedByMe ?? false,
          externalCount: externals.length,
          external: externals,
        });
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  return {
    user: userEmail.toLowerCase(),
    scannedFiles: scanned,
    truncated: !!pageToken,
    nextPageToken: pageToken ?? null,
    files: matches,
  };
}

/**
 * Per-batch cap for path resolution. Each file might trigger N
 * `files.get` calls for ancestor folders, but the per-tenant folder cache
 * amortises across the whole batch — most files share parents.
 */
export const PATH_RESOLVE_FILE_CAP = 1000;

/** Defensive limit on how far we'll walk up a parent chain. */
const PATH_RESOLVE_MAX_DEPTH = 50;

/**
 * How many files to resolve in parallel. Each file's ancestor climb is
 * inherently sequential, but independent files can run concurrently — and the
 * shared folder cache means overlapping ancestors are only fetched once. Keeps
 * a 1,000-file export from becoming 1,000 serial round trips.
 */
const PATH_RESOLVE_CONCURRENCY = 8;

interface FolderNode {
  name: string;
  parents: string[];
  driveId?: string;
}

/**
 * Resolve each file ID to its full Drive folder path. Climbs the parent
 * chain via `files.get`, caching folder metadata so a Drive with one file
 * per folder costs N calls but a Drive with a thousand files in one folder
 * costs ~2 calls (file + folder).
 *
 * The leaf file's own name is NOT included in the returned path — the CSV
 * already has a file_name column, so the path field describes "where the
 * file lives" rather than the file itself.
 *
 * Files at My Drive root resolve to "My Drive". Files in a Shared Drive
 * resolve to "Shared Drive: <name> / ...". Anything we can't resolve
 * (deleted folders, permission lost, weird metadata) gets a sentinel
 * "(path unavailable)" so the CSV row stays parseable.
 */
export async function resolveFilePaths(
  tenant: Tenant | null,
  userEmail: string,
  fileIds: string[]
): Promise<Record<string, string>> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return {};
  }
  if (fileIds.length > PATH_RESOLVE_FILE_CAP) {
    throw new Error(
      `Too many files in one resolve batch — cap is ${PATH_RESOLVE_FILE_CAP}`
    );
  }

  const drive = getDriveClient(tenant, userEmail);
  // Cache in-flight promises (not just resolved values) so two files climbing
  // through the same ancestor concurrently share a single API call.
  const folderCache = new Map<string, Promise<FolderNode | null>>();
  const driveNameCache = new Map<string, Promise<string>>();
  const out: Record<string, string> = {};

  const fetchNode = (id: string): Promise<FolderNode | null> => {
    const cached = folderCache.get(id);
    if (cached !== undefined) return cached;
    const p = (async (): Promise<FolderNode | null> => {
      try {
        const meta = await withGoogleRetry(
          () =>
            drive.files.get(
              {
                fileId: id,
                fields: "id, name, parents, driveId",
                supportsAllDrives: true,
              },
              { timeout: ADMIN_API_TIMEOUT_MS }
            ),
          { retryServerErrors: true }
        );
        return {
          name: meta.data.name || "(untitled)",
          parents: meta.data.parents || [],
          driveId: meta.data.driveId ?? undefined,
        };
      } catch {
        return null;
      }
    })();
    folderCache.set(id, p);
    return p;
  };

  const resolveDriveName = (driveId: string): Promise<string> => {
    const cached = driveNameCache.get(driveId);
    if (cached !== undefined) return cached;
    const p = (async (): Promise<string> => {
      try {
        const d = await withGoogleRetry(
          () => drive.drives.get({ driveId }, { timeout: ADMIN_API_TIMEOUT_MS }),
          { retryServerErrors: true }
        );
        return `Shared Drive: ${d.data.name || driveId}`;
      } catch {
        return `Shared Drive: ${driveId}`;
      }
    })();
    driveNameCache.set(driveId, p);
    return p;
  };

  const resolveOne = async (rawId: string): Promise<void> => {
    const fileId = String(rawId || "").trim();
    if (!fileId) return;
    const fileNode = await fetchNode(fileId);
    if (!fileNode) {
      out[fileId] = "(path unavailable)";
      return;
    }
    if (fileNode.parents.length === 0) {
      out[fileId] = fileNode.driveId
        ? await resolveDriveName(fileNode.driveId)
        : "My Drive";
      return;
    }

    const segments: string[] = [];
    let currentId: string | undefined = fileNode.parents[0];
    let depthExceeded = false;
    for (let i = 0; i < PATH_RESOLVE_MAX_DEPTH; i++) {
      if (!currentId) break;
      const folder = await fetchNode(currentId);
      if (!folder) {
        segments.unshift("(unknown folder)");
        break;
      }
      if (folder.parents.length === 0) {
        // A parentless node is normally the root container itself — My Drive's
        // root folder (named "My Drive") or a Shared Drive's root folder (named
        // after the drive) — so including its own name would duplicate the root
        // label: "My Drive / My Drive / …". Keep the name only when it differs,
        // which means we hit an orphaned folder rather than the real root.
        if (folder.driveId) {
          const label = await resolveDriveName(folder.driveId);
          if (folder.name && label !== `Shared Drive: ${folder.name}`) {
            segments.unshift(folder.name);
          }
          segments.unshift(label);
        } else {
          if (folder.name && folder.name !== "My Drive") {
            segments.unshift(folder.name);
          }
          segments.unshift("My Drive");
        }
        break;
      }
      segments.unshift(folder.name);
      currentId = folder.parents[0];
      if (i === PATH_RESOLVE_MAX_DEPTH - 1) depthExceeded = true;
    }
    if (depthExceeded) segments.unshift("…");

    out[fileId] = segments.join(" / ");
  };

  // Resolve files with bounded concurrency: a shared cursor hands each worker
  // the next file, so at most PATH_RESOLVE_CONCURRENCY climbs run at once.
  let cursor = 0;
  const worker = async () => {
    while (cursor < fileIds.length) {
      const idx = cursor++;
      await resolveOne(fileIds[idx]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PATH_RESOLVE_CONCURRENCY, fileIds.length) },
      worker
    )
  );

  return out;
}

function classifyPermission(
  p: drive_v3.Schema$Permission,
  verifiedDomains: Set<string>
): ExternalSharedFile["external"][number] | null {
  const role = p.role || "reader";
  if (p.type === "anyone") {
    return {
      type: "anyone",
      role,
      target: "*",
      allowFileDiscovery: p.allowFileDiscovery ?? null,
    };
  }
  if (p.type === "domain") {
    const domain = (p.domain || "").toLowerCase();
    if (!domain || verifiedDomains.has(domain)) return null;
    return {
      type: "domain",
      role,
      target: domain,
      allowFileDiscovery: p.allowFileDiscovery ?? null,
    };
  }
  if (p.type === "user" || p.type === "group") {
    const addr = (p.emailAddress || "").toLowerCase();
    if (!addr) return null;
    const dom = emailDomain(addr);
    if (verifiedDomains.has(dom)) return null;
    return {
      type: p.type,
      role,
      target: addr,
    };
  }
  return null;
}

export function isNotFoundError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: number; status?: number; response?: { status?: number } };
  return (
    err.code === 404 ||
    err.status === 404 ||
    err.response?.status === 404
  );
}

/**
 * Detect the "this resource already exists" rejection from Google APIs —
 * e.g. re-creating a Gmail forwarding address that's already registered.
 * Lets idempotent steps treat a duplicate as success and continue, so a
 * partially-failed flow can be safely retried. Matches the 409 status or
 * the stable phrasing, since wording shifts between APIs.
 */
export function isAlreadyExistsError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as {
    code?: number;
    status?: number;
    response?: { status?: number; data?: { error?: { message?: string } } };
    message?: string;
  };
  const status = err.code ?? err.status ?? err.response?.status;
  if (status === 409) return true;
  const msg = (
    err.response?.data?.error?.message ??
    err.message ??
    ""
  ).toLowerCase();
  return msg.includes("already exists") || msg.includes("duplicate");
}

/**
 * Detect Drive's "this permission is inherited, you can't delete it as the
 * file owner" rejection. Match phrasing rather than a single error code so
 * minor wording changes in the API don't bypass the admin-mode fallback.
 */
function isInheritedPermissionError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as {
    code?: number;
    status?: number;
    response?: { status?: number; data?: { error?: { message?: string } } };
    message?: string;
  };
  const status = err.code ?? err.status ?? err.response?.status;
  if (status !== 403) return false;
  const msg = (
    err.response?.data?.error?.message ??
    err.message ??
    ""
  ).toLowerCase();
  return (
    msg.includes("inherited") ||
    msg.includes("limited expansive access") ||
    msg.includes("cannot delete the permission")
  );
}

// ---------------------------------------------------------------------------
// External sharing remediation
// ---------------------------------------------------------------------------

export interface RevokeFileOutcome {
  fileId: string;
  /** Number of permissions actually deleted. */
  removed: number;
  /**
   * Of those removals, how many required falling back to domain-admin mode
   * because the user-scoped delete was rejected (typically Shared Drive
   * inherited permissions).
   */
  removedAsAdmin?: number;
  /** External permissions we tried to delete but couldn't, with the reason. */
  errors: Array<{ permissionId: string; target: string; message: string }>;
  /** True if the file was missing or no longer accessible. */
  notFound?: boolean;
  /** The user-facing display name we observed. */
  fileName?: string;
  /**
   * Diagnostic counts captured at revoke time. Useful for explaining
   * `removed: 0, errors: []` outcomes — most often the file's permissions
   * were already cleaned between audit and revoke, so the audit snapshot is
   * stale.
   */
  permissionsSeen?: number;
  /** Of permissionsSeen, how many were classified as external and matched the category filter. */
  permissionsTargeted?: number;
}

export interface RevokeBatchResult {
  user: string;
  results: RevokeFileOutcome[];
}

export type RevokeCategory = "anyone" | "domain" | "user" | "group";

export interface RevokeOptions {
  /**
   * Restrict revocation to permissions of these categories. If omitted, every
   * externally-classified permission is stripped (historical default).
   */
  categories?: RevokeCategory[];
}

/** Per-batch cap — protects the request handler from a runaway client. */
const REVOKE_FILE_CAP = 200;
// Revoke files with bounded concurrency. Each file needs files.get +
// permissions.list + N deletes; 8 in flight keeps a 200-file batch well within
// Drive's ~12k queries/min per-user budget while the retry layer absorbs the
// occasional 429.
const REVOKE_CONCURRENCY = 8;

/**
 * Strip every external permission from each requested file owned (or
 * editable) by `userEmail`.
 *
 * "External" is re-classified server-side against the live verified-domain
 * set so that a stale client snapshot can never cause us to delete an
 * internal collaborator.
 *
 * Per-permission errors are collected and returned, never thrown — one bad
 * permission shouldn't abort the rest of the batch.
 */
export async function revokeExternalPermissions(
  tenant: Tenant | null,
  userEmail: string,
  fileIds: string[],
  options: RevokeOptions = {}
): Promise<RevokeBatchResult> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    throw new Error("fileIds must be a non-empty array");
  }
  if (fileIds.length > REVOKE_FILE_CAP) {
    throw new Error(
      `Too many files in one revoke batch — cap is ${REVOKE_FILE_CAP}`
    );
  }
  if (options.categories !== undefined && options.categories.length === 0) {
    // Refuse silent no-op: an empty allowlist would filter every external
    // permission to "skip" and audit as success. Callers that want the
    // historical strip-all behavior should omit `categories` entirely.
    throw new Error("categories must be a non-empty array of permission types");
  }

  const allowedCategories = options.categories
    ? new Set<RevokeCategory>(options.categories)
    : null;

  const verifiedDomains = new Set(
    (await listDomains(tenant))
      .filter((d) => d.verified)
      .map((d) => d.domainName.toLowerCase())
  );
  // Fail closed. classifyPermission treats any collaborator outside
  // verifiedDomains as "external", so an empty set (domain re-verification
  // regression, an omitted `verified` field, or a failed domains fetch) would
  // reclassify EVERY internal collaborator as external and delete them. The
  // ownership-transfer path guards the same way — this destructive path must
  // too, rather than fail open.
  if (verifiedDomains.size === 0) {
    throw new Error(
      "No verified domains resolved for this tenant — refusing to revoke sharing, as every collaborator would be misclassified as external. Check the tenant's domain configuration and try again."
    );
  }
  if (!verifiedDomains.has(emailDomain(userEmail))) {
    throw new Error(
      `Owner's domain (${emailDomain(
        userEmail
      )}) is not a verified domain of this tenant — refusing to revoke sharing to avoid misclassifying internal collaborators.`
    );
  }

  const drive = getDriveClientWritable(tenant, userEmail);
  // Built lazily only if we actually need it — keeps the common all-clean batch
  // from doing an extra JWT exchange against Google's auth servers. Shared
  // across workers; the lazy init races benignly (both would build an
  // equivalent client), so no lock is needed.
  let adminDrive: drive_v3.Drive | null = null;
  const getAdminDrive = () => {
    if (!adminDrive) adminDrive = getDriveClientAsAdmin(tenant);
    return adminDrive;
  };

  // Process files with bounded concurrency. Each file's permission ops are
  // independent and idempotent (notFound deletes count as success), so a worker
  // pool is safe and cuts a 200-file batch from minutes to tens of seconds,
  // keeping the response inside typical reverse-proxy timeouts. Results are
  // written by original index so per-file outcomes stay in request order.
  const trimmed = fileIds.map((f) => String(f || "").trim());
  const results: RevokeFileOutcome[] = new Array(trimmed.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < trimmed.length) {
      const idx = cursor++;
      const fileId = trimmed[idx];
      if (!fileId) continue;
      results[idx] = await revokeForOneFile(
        drive,
        getAdminDrive,
        fileId,
        verifiedDomains,
        allowedCategories
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(REVOKE_CONCURRENCY, trimmed.length || 1) },
      worker
    )
  );

  return {
    user: userEmail.toLowerCase(),
    // Drop holes left by blank ids (skipped above) so the shape is unchanged.
    results: results.filter((r): r is RevokeFileOutcome => r !== undefined),
  };
}

async function revokeForOneFile(
  drive: drive_v3.Drive,
  getAdminDrive: () => drive_v3.Drive,
  fileId: string,
  verifiedDomains: Set<string>,
  allowedCategories: Set<RevokeCategory> | null
): Promise<RevokeFileOutcome> {
  const outcome: RevokeFileOutcome = {
    fileId,
    removed: 0,
    errors: [],
  };

  // Re-fetch live permissions so we never act on a stale client snapshot.
  const perms: drive_v3.Schema$Permission[] = [];
  let fileName: string | undefined;
  try {
    const meta = await withGoogleRetry(
      () =>
        drive.files.get(
          {
            fileId,
            fields: "id, name",
            supportsAllDrives: true,
          },
          { timeout: ADMIN_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    );
    fileName = meta.data.name ?? undefined;
    let pageToken: string | undefined;
    do {
      const r = await withGoogleRetry(
        () =>
          drive.permissions.list(
            {
              fileId,
              fields:
                "nextPageToken, permissions(id, type, role, emailAddress, domain, allowFileDiscovery)",
              pageSize: 100,
              pageToken,
              supportsAllDrives: true,
            },
            { timeout: ADMIN_API_TIMEOUT_MS }
          ),
        { retryServerErrors: true }
      );
      perms.push(...(r.data.permissions || []));
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (e) {
    if (isNotFoundError(e)) {
      outcome.notFound = true;
      return outcome;
    }
    outcome.errors.push({
      permissionId: "*",
      target: "(file)",
      message: e instanceof Error ? e.message : "Failed to list permissions",
    });
    return outcome;
  }
  outcome.fileName = fileName;
  outcome.permissionsSeen = perms.length;

  const externalPerms = perms.filter((p) => {
    const flag = classifyPermission(p, verifiedDomains);
    if (!flag) return false;
    if (allowedCategories && !allowedCategories.has(flag.type)) return false;
    return true;
  });
  outcome.permissionsTargeted = externalPerms.length;

  for (const p of externalPerms) {
    const target =
      p.type === "anyone"
        ? "anyone"
        : p.type === "domain"
        ? p.domain ?? "(domain)"
        : p.emailAddress ?? "(user)";
    if (!p.id) {
      outcome.errors.push({
        permissionId: "(missing)",
        target,
        message: "Permission has no id — cannot delete",
      });
      continue;
    }
    // Capture in a local so the narrowing survives inside the retry closures
    // below (TS drops property narrowing across a function boundary).
    const permissionId = p.id;

    try {
      await withGoogleRetry(
        () =>
          drive.permissions.delete(
            {
              fileId,
              permissionId,
              supportsAllDrives: true,
            },
            { timeout: ADMIN_API_TIMEOUT_MS }
          ),
        { retryServerErrors: true }
      );
      outcome.removed++;
    } catch (e) {
      if (isNotFoundError(e)) {
        // Already gone — count as success, no error needed.
        continue;
      }
      if (isInheritedPermissionError(e)) {
        // Retry as a domain admin with useDomainAdminAccess. This is the
        // only path Drive permits for inherited Shared Drive permissions.
        try {
          await withGoogleRetry(
            () =>
              getAdminDrive().permissions.delete(
                {
                  fileId,
                  permissionId,
                  supportsAllDrives: true,
                  useDomainAdminAccess: true,
                },
                { timeout: ADMIN_API_TIMEOUT_MS }
              ),
            { retryServerErrors: true }
          );
          outcome.removed++;
          outcome.removedAsAdmin = (outcome.removedAsAdmin ?? 0) + 1;
          continue;
        } catch (e2) {
          if (isNotFoundError(e2)) continue;
          outcome.errors.push({
            permissionId: p.id,
            target,
            message: `Inherited permission — domain-admin retry also failed: ${
              e2 instanceof Error ? e2.message : String(e2)
            }`,
          });
          continue;
        }
      }
      outcome.errors.push({
        permissionId: p.id,
        target,
        message:
          e instanceof Error ? e.message : "Failed to delete permission",
      });
    }
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Drive folder ownership transfer
// ---------------------------------------------------------------------------

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{8,256}$/;

/**
 * Drive accepts "root" as a magic value meaning "My Drive root folder".
 * Treated as a valid folder ID anywhere a folder reference is expected.
 */
function assertDriveFolderId(id: string): void {
  if (id === "root") return;
  if (!DRIVE_ID_RE.test(id)) {
    throw new Error(`Folder id ${JSON.stringify(id)} looks invalid`);
  }
}

export interface DriveFolderEntry {
  id: string;
  name: string;
  /** Whether the source user can probably transfer it (owned + not shared-drive). */
  ownedByUser: boolean;
}

export interface DriveFolderListing {
  /** Parent folder we're listing inside. Null for the My Drive root. */
  parent: { id: string; name: string } | null;
  folders: DriveFolderEntry[];
  nextPageToken: string | null;
}

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * List a user's folders, optionally under `parentId`. When `parentId` is
 * omitted the listing returns My Drive root folders.
 *
 * Returns only folders the user owns — these are the ones we can actually
 * transfer ownership of. Shared-drive contents and "shared with me" items
 * are excluded by construction.
 *
 * Impersonates the user via DWD so we see exactly what they see in Drive.
 */
export async function listDriveFolders(
  tenant: Tenant | null,
  userEmail: string,
  parentId?: string,
  pageToken?: string
): Promise<DriveFolderListing> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }
  const effectiveParent = parentId ?? "root";
  assertDriveFolderId(effectiveParent);

  const drive = getDriveClient(tenant, userEmail);

  // Drive's `q` string is a SQL-ish DSL — single-quote the parent id and
  // escape any internal quotes. Drive ids are alphanumeric+_- by construction
  // (already validated above) so this is belt-and-braces.
  const escapedParent = effectiveParent.replace(/'/g, "\\'");
  const q = `'${escapedParent}' in parents and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false and 'me' in owners`;

  // The children listing and the parent-name lookup are independent — run them
  // concurrently (and with the standard retry) so every folder-picker
  // navigation costs one round trip instead of two.
  const [res, parent] = await Promise.all([
    withGoogleRetry(
      () =>
        drive.files.list(
          {
            q,
            fields: "nextPageToken, files(id, name, ownedByMe)",
            pageSize: 200,
            pageToken,
            orderBy: "name",
            // Restrict to the user's corpus — keeps shared-drive items out.
            corpora: "user",
          },
          { timeout: ADMIN_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    ),
    (async (): Promise<{ id: string; name: string } | null> => {
      if (!parentId) return null;
      try {
        const meta = await withGoogleRetry(
          () =>
            drive.files.get(
              { fileId: parentId, fields: "id, name" },
              { timeout: ADMIN_API_TIMEOUT_MS }
            ),
          { retryServerErrors: true }
        );
        return {
          id: meta.data.id || parentId,
          name: meta.data.name || "(folder)",
        };
      } catch {
        return { id: parentId, name: "(folder)" };
      }
    })(),
  ]);

  const folders: DriveFolderEntry[] = (res.data.files || []).map((f) => ({
    id: f.id || "",
    name: f.name || "(untitled)",
    ownedByUser: f.ownedByMe ?? true,
  }));

  return {
    parent,
    folders,
    nextPageToken: res.data.nextPageToken || null,
  };
}

/**
 * Cursor describing where a transfer left off. The client passes this back to
 * resume a long-running transfer in chunked requests.
 *
 * - `queue` holds folders we still need to descend into.
 * - `current` is the folder we're partway through paginating.
 */
export interface DriveTransferCursor {
  queue: string[];
  current: {
    folderId: string;
    pageToken: string | null;
    selfTransferred: boolean;
  } | null;
  /**
   * The folders the operator originally selected. A folder reached by walking
   * is listed by its single parent exactly once, so only a SELECTED folder can
   * be rediscovered (as a child of another selected folder) in a later chunk
   * after its own walk finished. Carrying the selection lets every chunk skip
   * such a subtree instead of walking — and counting — it twice. Bounded by
   * TRANSFER_FOLDER_SELECTION_CAP.
   */
  selected?: string[];
}

export interface DriveTransferErrorEntry {
  id: string;
  name: string | null;
  message: string;
}

export interface DriveTransferProgress {
  transferred: number;
  alreadyOwned: number;
  notOwned: number;
  errors: DriveTransferErrorEntry[];
  /** Cursor to pass into the next call. Null when the entire selection is done. */
  nextCursor: DriveTransferCursor | null;
}

/** Per-request work budget. Bounded so each call stays well under request timeouts. */
const TRANSFER_BATCH_BUDGET = 500;
// Transfer a page's children with bounded concurrency. Each item costs
// permissions.list + an update/create; 6 in flight keeps a 500-item chunk to
// tens of seconds (inside typical proxy timeouts) while staying well under
// Drive's per-user quota, with the retry layer absorbing the occasional 429.
const TRANSFER_CHILD_CONCURRENCY = 6;

/** Hard cap on initial folder selections to keep cursors small. */
const TRANSFER_FOLDER_SELECTION_CAP = 100;

/** Hard cap on cursor queue depth to keep payloads bounded. */
const TRANSFER_QUEUE_HARD_CAP = 20000;

export function buildInitialTransferCursor(
  folderIds: string[]
): DriveTransferCursor {
  if (folderIds.length === 0) {
    throw new Error("folderIds must be a non-empty array");
  }
  if (folderIds.length > TRANSFER_FOLDER_SELECTION_CAP) {
    throw new Error(
      `Too many folders selected — cap is ${TRANSFER_FOLDER_SELECTION_CAP}`
    );
  }
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const raw of folderIds) {
    const id = String(raw || "").trim();
    assertDriveFolderId(id);
    if (id === "root") {
      throw new Error(
        "Cannot transfer ownership of My Drive root — pick specific folders inside it"
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(id);
  }
  return { queue, current: null, selected: [...queue] };
}

/**
 * Validate a cursor that came back from the client. Defensive: even though
 * the client only echoes what we sent, we never trust round-tripped state.
 */
function sanitizeCursor(cursor: unknown): DriveTransferCursor {
  if (typeof cursor !== "object" || cursor === null) {
    throw new Error("cursor must be an object");
  }
  const c = cursor as { queue?: unknown; current?: unknown; selected?: unknown };
  if (!Array.isArray(c.queue)) {
    throw new Error("cursor.queue must be an array");
  }
  if (c.queue.length > TRANSFER_QUEUE_HARD_CAP) {
    throw new Error(
      `cursor.queue exceeds hard cap of ${TRANSFER_QUEUE_HARD_CAP} entries`
    );
  }
  const queue: string[] = [];
  for (const q of c.queue) {
    if (typeof q !== "string") throw new Error("cursor.queue entries must be strings");
    assertDriveFolderId(q);
    // buildInitialTransferCursor refuses "root"; the continuation path must too,
    // or a crafted cursor could walk and transfer the entire My Drive.
    if (q === "root") {
      throw new Error("cursor may not reference My Drive root");
    }
    queue.push(q);
  }
  let current: DriveTransferCursor["current"] = null;
  if (c.current !== undefined && c.current !== null) {
    const cur = c.current as {
      folderId?: unknown;
      pageToken?: unknown;
      selfTransferred?: unknown;
    };
    if (typeof cur.folderId !== "string") {
      throw new Error("cursor.current.folderId must be a string");
    }
    assertDriveFolderId(cur.folderId);
    if (cur.folderId === "root") {
      throw new Error("cursor may not reference My Drive root");
    }
    let pageToken: string | null = null;
    if (cur.pageToken !== null && cur.pageToken !== undefined) {
      if (typeof cur.pageToken !== "string" || cur.pageToken.length > 4096) {
        throw new Error("cursor.current.pageToken is malformed");
      }
      pageToken = cur.pageToken;
    }
    current = {
      folderId: cur.folderId,
      pageToken,
      selfTransferred: cur.selfTransferred === true,
    };
  }
  let selected: string[] | undefined;
  if (c.selected !== undefined && c.selected !== null) {
    if (!Array.isArray(c.selected)) {
      throw new Error("cursor.selected must be an array");
    }
    if (c.selected.length > TRANSFER_FOLDER_SELECTION_CAP) {
      throw new Error(
        `cursor.selected exceeds the selection cap of ${TRANSFER_FOLDER_SELECTION_CAP}`
      );
    }
    selected = [];
    for (const s of c.selected) {
      if (typeof s !== "string") {
        throw new Error("cursor.selected entries must be strings");
      }
      assertDriveFolderId(s);
      if (s === "root") {
        throw new Error("cursor may not reference My Drive root");
      }
      selected.push(s);
    }
  }
  return selected ? { queue, current, selected } : { queue, current };
}

export function sanitizeTransferCursor(cursor: unknown): DriveTransferCursor {
  return sanitizeCursor(cursor);
}

/**
 * Transfer ownership of the selected folders and every owned item beneath
 * them from `fromUser` to `toUser`. Processes a bounded chunk per call —
 * `nextCursor` in the response is non-null when more work remains.
 *
 * Drive does not inherit owner permissions down a tree: every file and
 * subfolder has its own owner record. This walks the tree breadth-first,
 * transferring each owned item individually.
 *
 * Items the source user does not own are silently skipped (counted under
 * `notOwned`) — we can't transfer what we don't own. Per-item failures are
 * collected, never thrown, so one bad item doesn't abort the batch.
 */
export async function transferDriveFoldersOwnership(
  tenant: Tenant | null,
  fromUser: string,
  toUser: string,
  cursor: DriveTransferCursor
): Promise<DriveTransferProgress> {
  if (!isValidEmail(fromUser) || !isValidEmail(toUser)) {
    throw new Error("fromUser and toUser must be valid email addresses");
  }
  if (fromUser.toLowerCase() === toUser.toLowerCase()) {
    throw new Error("fromUser and toUser must be different");
  }

  const verified = new Set(
    (await listDomains(tenant))
      .filter((d) => d.verified)
      .map((d) => d.domainName.toLowerCase())
  );
  const fromDom = emailDomain(fromUser);
  const toDom = emailDomain(toUser);
  if (!verified.has(fromDom)) {
    throw new Error(
      `Source user's domain (${fromDom}) is not a verified domain of this tenant — Drive ownership transfers must stay inside the tenant`
    );
  }
  if (!verified.has(toDom)) {
    throw new Error(
      `Target user's domain (${toDom}) is not a verified domain of this tenant — Drive ownership transfers must stay inside the tenant`
    );
  }

  const drive = getDriveClientWritable(tenant, fromUser);

  const local: DriveTransferCursor = {
    queue: [...cursor.queue],
    current: cursor.current ? { ...cursor.current } : null,
    ...(cursor.selected ? { selected: [...cursor.selected] } : {}),
  };
  // Every folder known to this call — queued, in progress, dequeued during
  // the loop below, or part of the original selection (which earlier chunks
  // may already have walked to completion). Discovered subfolders already in
  // here are NOT re-enqueued: a selection of a parent plus its subfolder would
  // otherwise walk that subtree twice.
  const enqueuedFolders = new Set<string>([
    ...local.queue,
    ...(local.selected ?? []),
  ]);
  if (local.current) enqueuedFolders.add(local.current.folderId);

  const out: DriveTransferProgress = {
    transferred: 0,
    alreadyOwned: 0,
    notOwned: 0,
    errors: [],
    nextCursor: null,
  };

  let budget = TRANSFER_BATCH_BUDGET;
  const toUserLower = toUser.toLowerCase();

  // The item budget alone can't bound this loop: Drive may return sparse or
  // empty list pages while still supplying a nextPageToken, and an empty page
  // consumes no budget — so one route call could chain list requests without
  // limit. The page bound keeps a single chunk's latency predictable; work
  // left over resumes via nextCursor exactly like a spent item budget.
  const TRANSFER_MAX_LIST_PAGES = 50;
  let listPagesFetched = 0;

  while (budget > 0 && listPagesFetched < TRANSFER_MAX_LIST_PAGES) {
    if (!local.current) {
      const next = local.queue.shift();
      if (!next) break;
      local.current = {
        folderId: next,
        pageToken: null,
        selfTransferred: false,
      };
    }

    // The folder itself needs ownership transferred too — Drive treats it as
    // just another file. Do this once per folder before listing children so
    // we don't double-count on a continuation.
    if (!local.current.selfTransferred) {
      const result = await transferOneItem(drive, local.current.folderId, toUserLower);
      applyTransferResult(out, local.current.folderId, null, result);
      local.current.selfTransferred = true;
      budget--;
      if (budget === 0) break;
    }

    const folderId = local.current.folderId;
    listPagesFetched++;
    const escapedParent = folderId.replace(/'/g, "\\'");
    // List EVERY child, not just those owned by the source. A subfolder owned
    // by someone else can still contain files the departing user owns; if we
    // pruned it here we'd never descend into it and would silently leave those
    // files behind (they'd be deleted with the account). transferOneItem
    // classifies each item — owned items transfer, others are counted under
    // notOwned — so the counters stay honest and match the documented contract.
    const q = `'${escapedParent}' in parents and trashed = false`;
    const pageSize = Math.min(100, Math.max(1, budget));

    let listRes;
    try {
      listRes = await withGoogleRetry(
        () =>
          drive.files.list(
            {
              q,
              // ownedByMe + owners let us classify non-owned children straight
              // from the listing instead of spending a permissions.list plus a
              // guaranteed-failing ownership write on every item the source
              // user doesn't own.
              fields:
                "nextPageToken, files(id, name, mimeType, ownedByMe, owners(emailAddress))",
              pageSize,
              pageToken: local.current!.pageToken ?? undefined,
              corpora: "user",
            },
            { timeout: ADMIN_API_TIMEOUT_MS }
          ),
        { retryServerErrors: true }
      );
    } catch (e) {
      // Record the listing failure against the folder itself and move on so
      // the rest of the selection isn't held up by one bad branch.
      out.errors.push({
        id: folderId,
        name: null,
        message: `Failed to list children: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
      local.current = null;
      continue;
    }

    // Transfer this page's children with bounded concurrency. Each item is
    // independent and transferOneItem is idempotent, so ordering doesn't affect
    // the counters or the queue. pageSize <= budget, so processing the whole
    // page never overruns the chunk budget. JS is single-threaded, so the
    // synchronous counter/queue mutations below can't interleave mid-statement.
    const children = listRes.data.files || [];
    // Subfolders discovered this page, collected during the parallel pass and
    // enqueued serially afterwards so the queue hard-cap check can't race.
    const discoveredFolders: Array<{ id: string; name: string | null }> = [];
    let childCursor = 0;
    const childWorker = async () => {
      while (childCursor < children.length) {
        const child = children[childCursor++];
        const childId = child.id;
        if (!childId) continue;
        let result: TransferOneOutcome;
        if (child.ownedByMe === false) {
          // Not the source user's item — no transfer is possible, so classify
          // from the listing metadata without any per-item API calls. Folders
          // still get enqueued below: a non-owned subfolder can contain files
          // the departing user DOES own.
          const ownerEmails = (child.owners || []).map((o) =>
            (o.emailAddress || "").toLowerCase()
          );
          result = ownerEmails.includes(toUserLower)
            ? { kind: "alreadyOwned" }
            : { kind: "notOwned", reason: "Not owned by the source user" };
        } else {
          result = await transferOneItem(drive, childId, toUserLower);
        }
        applyTransferResult(out, childId, child.name ?? null, result);
        if (child.mimeType === DRIVE_FOLDER_MIME) {
          discoveredFolders.push({ id: childId, name: child.name ?? null });
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(TRANSFER_CHILD_CONCURRENCY, children.length || 1) },
        childWorker
      )
    );
    for (const f of discoveredFolders) {
      // Skip folders already awaiting (or having had) a walk this call — a
      // selection containing both a parent and its subfolder would otherwise
      // walk that subtree twice, doubling the API spend and inflating counters.
      if (enqueuedFolders.has(f.id)) continue;
      if (local.queue.length >= TRANSFER_QUEUE_HARD_CAP) {
        out.errors.push({
          id: f.id,
          name: f.name,
          message:
            "Skipped: cursor queue hard cap reached — re-run after this chunk completes",
        });
      } else {
        enqueuedFolders.add(f.id);
        local.queue.push(f.id);
      }
    }
    budget -= children.length;

    // Save resume state; the `while (budget > 0)` guard breaks the loop when the
    // chunk budget is spent, and nextCursor below carries `local` to the client.
    if (listRes.data.nextPageToken) {
      local.current.pageToken = listRes.data.nextPageToken;
    } else {
      local.current = null;
    }
  }

  if (local.current || local.queue.length > 0) {
    out.nextCursor = local;
  }
  return out;
}

type TransferOneOutcome =
  | { kind: "transferred" }
  | { kind: "alreadyOwned" }
  | { kind: "notOwned"; reason: string }
  | { kind: "error"; message: string };

/**
 * Match the various error strings Drive returns when ownership cannot be
 * transferred because the impersonated user isn't the current owner. Drive's
 * exact wording shifts over time so we match on stable substrings.
 */
function isNotOwnerError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("only the current owner") ||
    m.includes("not the current owner") ||
    m.includes("owner only") ||
    m.includes("consumer accounts") ||
    m.includes("different domain")
  );
}

async function transferOneItem(
  drive: drive_v3.Drive,
  fileId: string,
  toUserLower: string
): Promise<TransferOneOutcome> {
  const perms: drive_v3.Schema$Permission[] = [];
  try {
    // Paginate: a file with >100 permissions could hide the target user's
    // existing grant on a later page, which would make us take the create path
    // for an already-owned file and misreport it. Include nextPageToken in the
    // field mask (a single-page fetch can't paginate without it).
    let pageToken: string | undefined;
    do {
      const res = await withGoogleRetry(
        () =>
          drive.permissions.list(
            {
              fileId,
              fields:
                "nextPageToken, permissions(id, type, role, emailAddress)",
              pageSize: 100,
              pageToken,
              supportsAllDrives: true,
            },
            { timeout: ADMIN_API_TIMEOUT_MS }
          ),
        { retryServerErrors: true }
      );
      perms.push(...(res.data.permissions || []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (e) {
    if (isNotFoundError(e)) {
      return { kind: "notOwned", reason: "File no longer accessible" };
    }
    return {
      kind: "error",
      message: e instanceof Error ? e.message : "Failed to list permissions",
    };
  }

  const targetPerm = perms.find(
    (p) =>
      p.type === "user" &&
      (p.emailAddress || "").toLowerCase() === toUserLower
  );
  if (targetPerm?.role === "owner") {
    return { kind: "alreadyOwned" };
  }

  try {
    if (targetPerm?.id) {
      // Promoting an existing grant to owner is idempotent, so a 5xx retry is
      // safe here.
      await withGoogleRetry(
        () =>
          drive.permissions.update(
            {
              fileId,
              permissionId: targetPerm.id!,
              requestBody: { role: "owner" },
              transferOwnership: true,
              supportsAllDrives: true,
            },
            { timeout: ADMIN_API_TIMEOUT_MS }
          ),
        { retryServerErrors: true }
      );
    } else {
      // Only retry rate-limit rejections for create: a 5xx might have committed
      // the ownership grant, and a blind retry could surface a confusing
      // "already owner" error, so leave server-error retries off.
      await withGoogleRetry(
        () =>
          drive.permissions.create(
            {
              fileId,
              requestBody: {
                type: "user",
                role: "owner",
                emailAddress: toUserLower,
              },
              transferOwnership: true,
              // Drive ignores sendNotificationEmail=false for ownership transfers
              // and always sends a notification; leaving the field off avoids API
              // warnings while documenting the behaviour for future readers.
              supportsAllDrives: true,
            },
            { timeout: ADMIN_API_TIMEOUT_MS }
          ),
        { retryServerErrors: false }
      );
    }
    return { kind: "transferred" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isNotOwnerError(msg)) {
      // "Not the current owner" can also mean the ownership ALREADY moved: a
      // 5xx-committed first attempt whose retry now fails, or a concurrent
      // chunk that beat us to the same item. Verify before misreporting a
      // completed transfer as notOwned — this path is rare (owned items only
      // reach here through those races), so the extra read is cheap.
      try {
        let pageToken: string | undefined;
        do {
          const check = await withGoogleRetry(
            () =>
              drive.permissions.list(
                {
                  fileId,
                  fields: "nextPageToken, permissions(type, role, emailAddress)",
                  pageSize: 100,
                  pageToken,
                  supportsAllDrives: true,
                },
                { timeout: ADMIN_API_TIMEOUT_MS }
              ),
            { retryServerErrors: true }
          );
          const nowOwner = (check.data.permissions || []).some(
            (p) =>
              p.type === "user" &&
              (p.emailAddress || "").toLowerCase() === toUserLower &&
              p.role === "owner"
          );
          if (nowOwner) return { kind: "transferred" };
          pageToken = check.data.nextPageToken ?? undefined;
        } while (pageToken);
      } catch {
        // Verification unavailable — fall through to the original outcome.
      }
      return { kind: "notOwned", reason: msg };
    }
    return { kind: "error", message: msg };
  }
}

function applyTransferResult(
  out: DriveTransferProgress,
  id: string,
  name: string | null,
  result: TransferOneOutcome
): void {
  switch (result.kind) {
    case "transferred":
      out.transferred++;
      return;
    case "alreadyOwned":
      out.alreadyOwned++;
      return;
    case "notOwned":
      out.notOwned++;
      return;
    case "error":
      out.errors.push({ id, name, message: result.message });
      return;
  }
}

// ---------------------------------------------------------------------------
// Mailbox export / import
//
// Export walks a user's Gmail and returns every message as its raw RFC 822
// MIME blob (base64url), one page at a time, so the client can stream a whole
// mailbox to disk without holding it server-side. Import inserts those raw
// messages into another mailbox via messages.insert (IMAP-APPEND semantics —
// no re-delivery, no spam reclassification), recreating the source's user
// labels by name first so restored mail keeps its organisation.
// ---------------------------------------------------------------------------

// Minimal scopes per operation. Export only reads; import only inserts and
// manages labels — keeping them separate means a compromised export token
// can never write to a mailbox.
const GMAIL_READONLY_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];
const GMAIL_INSERT_SCOPES = ["https://www.googleapis.com/auth/gmail.insert"];
const GMAIL_LABELS_SCOPES = ["https://www.googleapis.com/auth/gmail.labels"];

// Raw messages (with attachments) can be large and slow to transfer, so the
// per-call Gmail timeout is more generous than the Admin SDK default.
const MAILBOX_API_TIMEOUT_MS = 60_000;

const MAILBOX_EXPORT_DEFAULT_PAGE = 25;
const MAILBOX_EXPORT_MAX_PAGE = 50;
// Fetch raw messages in parallel per page. messages.get costs 5 quota units,
// so 6 in flight peaks at ~30 units/sec — several times faster than a serial
// walk while staying well under Gmail's 250 units/user/sec budget, with the
// retry layer absorbing the occasional 429. The count also bounds the byte
// budget's overshoot (see below), so it cannot be raised independently.
const MAILBOX_EXPORT_FETCH_CONCURRENCY = 6;
// Cumulative raw-byte budget per returned page. A single Gmail message can be
// ~67 MB base64url, so a page capped only by message count (up to 50) could
// hold multiple GB and throw `RangeError: Invalid string length` when
// NextResponse.json stringifies it — leaving that pageToken permanently
// unfinishable. Once a page's fetched bytes reach this budget we stop and
// return the remaining ids as `pendingIds` for the next call.
//
// The budget check happens when a worker CLAIMS the next id, so in-flight
// fetches can overshoot it by up to (concurrency - 1) × max-message: with
// 6 workers that's 48 MB + 5 × 67 MB ≈ 383 MB. V8's real string cap is
// 2^29 - 24 chars (~512 MiB, not 1 GB), so the worst case clears it with
// margin — raising either the budget or the concurrency erodes that margin.
// Always fetch at least one id so a lone oversized message still progresses.
const MAILBOX_EXPORT_PAGE_BYTE_BUDGET = 48 * 1024 * 1024;

/** Hard cap on messages accepted in a single import batch. */
export const MAILBOX_IMPORT_BATCH_CAP = 25;
// Insert messages with bounded concurrency. Gmail's insert quota (~10/user/sec)
// comfortably allows a few in flight; 3 keeps throughput up without tripping
// sustained rate limits.
const MAILBOX_IMPORT_INSERT_CONCURRENCY = 3;
// Gmail accepts messages up to ~50 MB of decoded RFC 822 bytes. `format=raw`
// returns those bytes base64url-encoded, which inflates them by ~4/3 — so a
// max-size message is ~67 MB of characters. The cap is set above that (with
// margin) so a large-but-legal message isn't rejected before it reaches Gmail,
// while still rejecting obviously bogus input early. Keep this comfortably
// below the import route's body cap (see MAX_BODY_BYTES there).
export const MAILBOX_MAX_RAW_CHARS = 72 * 1024 * 1024;

// Gmail label IDs are short opaque tokens (e.g. "INBOX", "Label_42",
// "CATEGORY_PERSONAL"). Reject anything that doesn't look like one before it
// reaches the API.
const GMAIL_LABEL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The complete, fixed set of Gmail system-label IDs. These IDs are identical
 * across every mailbox, so a message tagged with one can be imported as-is.
 * We key "is this a system label?" off this set rather than the `type` field
 * in the export header — that field is supplied by the (operator-uploaded)
 * file and must not be trusted to decide whether to map an ID straight through
 * or to match a user label by name.
 */
const SYSTEM_LABEL_IDS = new Set([
  "INBOX",
  "SENT",
  "DRAFT",
  "TRASH",
  "SPAM",
  "STARRED",
  "UNREAD",
  "IMPORTANT",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

/**
 * System labels that must never be applied via messages.insert. CHAT is
 * reserved for Hangouts/Chat history and DRAFT belongs to the drafts API —
 * inserting a message tagged with either is rejected by Gmail.
 */
const NON_IMPORTABLE_LABELS = new Set(["CHAT", "DRAFT"]);

export interface GmailLabelInfo {
  id: string;
  name: string;
  /** "system" (INBOX, SENT, …) or "user" (custom labels). */
  type: string;
}

export interface ExportedMessage {
  id: string;
  threadId: string;
  /** Epoch-ms string as Gmail returns it, or null if absent. */
  internalDate: string | null;
  labelIds: string[];
  sizeEstimate: number;
  /** Full RFC 822 message, base64url-encoded (Gmail `format=raw`). */
  raw: string;
}

export interface MailboxExportPage {
  user: string;
  messages: ExportedMessage[];
  /** Pass back as `pageToken` to fetch the next page. Null when done. */
  nextPageToken: string | null;
  /** Gmail's rough total-message estimate, for progress display. */
  resultSizeEstimate: number | null;
  /**
   * Messages on this page that couldn't be fetched even after retries (e.g.
   * deleted mid-walk, or a persistent backend error). They're reported rather
   * than aborting the whole export — a backup with a known, listed gap beats a
   * backup that dies on message 9,001 of 50,000.
   */
  skipped: Array<{ id: string; error: string }>;
  /**
   * Message ids from the CURRENT list page that weren't fetched because the
   * page's cumulative byte budget was reached. Non-null means "call again with
   * these `pendingIds` (and the same `nextPageToken`) before advancing to the
   * next list page." Null/empty when the whole list page was fetched.
   */
  pendingIds: string[] | null;
  /**
   * The mailbox's labels. Returned only on the very first call (no `pageToken`
   * and no `pendingIds`), so the client can write them once into the export
   * header.
   */
  labels?: GmailLabelInfo[];
}

/** Best-effort extraction of an HTTP status from a googleapis error. */
function httpStatusOf(e: unknown): number | null {
  if (typeof e !== "object" || e === null) return null;
  const err = e as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  // Try each source in turn and return the first that yields a real number —
  // gaxios sometimes puts a non-numeric string (e.g. "ERR_BAD_REQUEST") in
  // `.code` while the actual HTTP status lives on `.response.status`.
  for (const raw of [err.status, err.response?.status, err.code]) {
    // `Number(null)` is 0, which would read as a real status and hide a
    // network error behind "status 0" — skip absent values explicitly.
    if (raw === null || raw === undefined) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** The HTTP status a Google API rejection carried, for routes mapping errors. */
export function googleHttpStatus(e: unknown): number | null {
  return httpStatusOf(e);
}

/**
 * Collect the machine-readable `reason` codes (and any quota-limit names) a
 * Google API error carries, from every place the client libraries put them:
 * the legacy `errors[].reason` list (Drive, Gmail, Calendar) and the newer
 * ErrorInfo `details[]` entries (Admin SDK, Reports). Lower-cased.
 */
function googleErrorInfo(e: unknown): { reasons: string[]; quotaLimits: string[] } {
  const reasons: string[] = [];
  const quotaLimits: string[] = [];
  if (typeof e !== "object" || e === null) return { reasons, quotaLimits };
  const err = e as {
    errors?: unknown;
    response?: { data?: { error?: { errors?: unknown; details?: unknown } } };
  };
  const collect = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const entry = item as
        | { reason?: unknown; metadata?: { quota_limit?: unknown } }
        | null;
      if (typeof entry?.reason === "string" && entry.reason) {
        reasons.push(entry.reason.toLowerCase());
      }
      const limit = entry?.metadata?.quota_limit;
      if (typeof limit === "string" && limit) quotaLimits.push(limit.toLowerCase());
    }
  };
  collect(err.errors);
  collect(err.response?.data?.error?.errors);
  collect(err.response?.data?.error?.details);
  return { reasons, quotaLimits };
}

// Per-user / per-minute throttles: the request was rejected before any work,
// so backing off and retrying is safe and usually succeeds.
const RATE_LIMIT_REASONS = new Set([
  "ratelimitexceeded",
  "userratelimitexceeded",
  "sharingratelimitexceeded",
  "rate_limit_exceeded",
  "resource_exhausted",
]);
// Budget exhaustion: a retry seconds later can never succeed and only burns
// the whole backoff schedule (~10 s) before surfacing the same error.
const EXHAUSTED_QUOTA_REASONS = new Set([
  "dailylimitexceeded",
  "storagequotaexceeded",
]);

/**
 * Decide whether a failed Google API call (Gmail, Drive, or Admin SDK) is worth
 * retrying.
 *
 * 429 (rate limit) is safe — the request was rejected before any work.
 * Google also signals per-user rate limits as 403 with a rate/quota reason
 * (Drive's `userRateLimitExceeded`, Gmail's `rateLimitExceeded`, the Admin
 * SDK's per-minute quotas), so we honour those. Daily-quota and storage-quota
 * exhaustion look similar but cannot clear within a backoff window, so they are
 * never retried. 5xx backend blips and bare network errors are retriable only
 * for idempotent operations (`retryServerErrors`), never for non-idempotent
 * writes like message inserts, where a 5xx might have committed and a blind
 * retry would duplicate.
 */
function isRetriableGoogleError(
  e: unknown,
  opts: { retryServerErrors: boolean }
): boolean {
  const status = httpStatusOf(e);
  const msg =
    typeof e === "object" && e && "message" in e
      ? String((e as { message?: unknown }).message ?? "").toLowerCase()
      : "";
  const { reasons, quotaLimits } = googleErrorInfo(e);
  const exhausted =
    reasons.some((r) => EXHAUSTED_QUOTA_REASONS.has(r)) ||
    quotaLimits.some((q) => q.includes("perday")) ||
    /per day|daily limit|daily quota|storage quota/.test(msg);
  if (exhausted) return false;
  const rateLimited =
    reasons.some((r) => RATE_LIMIT_REASONS.has(r)) ||
    msg.includes("rate limit") ||
    msg.includes("ratelimit") ||
    msg.includes("user rate") ||
    msg.includes("quota");
  if (status === 429) return true;
  if (status === 403 && rateLimited) return true;
  if (opts.retryServerErrors) {
    if (status !== null && status >= 500 && status <= 599) return true;
    if (
      status === null &&
      (msg.includes("econnreset") ||
        msg.includes("etimedout") ||
        msg.includes("socket hang up") ||
        msg.includes("network") ||
        msg.includes("timeout"))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Retry a Google API call with exponential backoff + jitter on transient errors.
 *
 * Exported so API routes that talk to Gmail / Calendar directly get the same
 * rate-limit handling as the Admin SDK helpers here: use
 * `retryServerErrors: false` for non-idempotent writes (create, insert) and
 * `true` for reads and idempotent settings updates.
 */
export async function withGoogleRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; retryServerErrors: boolean }
): Promise<T> {
  const retries = opts.retries ?? 5;
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt > retries || !isRetriableGoogleError(e, opts)) throw e;
      const backoff = Math.min(8000, 300 * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 300);
      await new Promise((r) => setTimeout(r, backoff + jitter));
    }
  }
}

/** List a mailbox's labels (system + user). Read-only. */
export async function listGmailLabels(
  tenant: Tenant | null,
  userEmail: string
): Promise<GmailLabelInfo[]> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }
  const gmail = buildGmailClient(tenant, userEmail, GMAIL_READONLY_SCOPES);
  const res = await withGoogleRetry(
    () =>
      gmail.users.labels.list(
        { userId: "me" },
        { timeout: MAILBOX_API_TIMEOUT_MS }
      ),
    { retryServerErrors: true }
  );
  return (res.data.labels || []).map((l) => ({
    id: l.id || "",
    name: l.name || "",
    type: l.type || "user",
  }));
}

/**
 * Export one page of a user's mailbox.
 *
 * Lists up to `pageSize` message IDs (default 25, capped at 50), then fetches
 * each as its raw MIME blob with bounded concurrency, stopping once the page's
 * cumulative byte budget is reached and returning any unfetched ids as
 * `pendingIds`. The client re-calls with those `pendingIds` (carrying the same
 * `nextPageToken`) before advancing to the next list page. The very first call
 * (no `pageToken` and no `pendingIds`) also carries the label set so the client
 * can record it once in the export header. Read-only.
 */
export async function exportMailboxPage(
  tenant: Tenant | null,
  userEmail: string,
  opts: {
    pageToken?: string;
    pageSize?: number;
    includeSpamTrash?: boolean;
    /** Unfetched ids from a prior page whose byte budget was reached. */
    pendingIds?: string[];
  } = {}
): Promise<MailboxExportPage> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }
  const pageSize = Math.min(
    MAILBOX_EXPORT_MAX_PAGE,
    Math.max(1, opts.pageSize ?? MAILBOX_EXPORT_DEFAULT_PAGE)
  );

  const gmail = buildGmailClient(tenant, userEmail, GMAIL_READONLY_SCOPES);

  // Two continuation modes:
  //  - pendingIds present → keep draining the current list page's ids; carry
  //    its nextPageToken (opts.pageToken) through unchanged.
  //  - otherwise → list the next page of ids as usual.
  let ids: string[];
  let listNextPageToken: string | null;
  let resultSizeEstimate: number | null;
  const continuing = !!(opts.pendingIds && opts.pendingIds.length > 0);
  if (continuing) {
    ids = opts.pendingIds!;
    listNextPageToken = opts.pageToken ?? null;
    resultSizeEstimate = null;
  } else {
    const listRes = await withGoogleRetry(
      () =>
        gmail.users.messages.list(
          {
            userId: "me",
            maxResults: pageSize,
            pageToken: opts.pageToken,
            includeSpamTrash: opts.includeSpamTrash ?? false,
          },
          { timeout: MAILBOX_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    );
    ids = (listRes.data.messages || [])
      .map((m) => m.id)
      .filter((id): id is string => !!id);
    listNextPageToken = listRes.data.nextPageToken || null;
    resultSizeEstimate = listRes.data.resultSizeEstimate ?? null;
  }

  // Preserve list order in the output so the export reads in the same order
  // Gmail returned it (newest first), even though fetches complete out of order.
  const messages: (ExportedMessage | undefined)[] = new Array(ids.length);
  const skipped: Array<{ id: string; error: string }> = [];
  // Cumulative raw bytes fetched this page. Once it reaches the budget we stop
  // claiming new ids; workers claim sequentially, so the fetched set is always a
  // prefix [0, cursor) and the tail is returned as pendingIds. The `?? 0` and
  // `budgetReached` flag guarantee at least one message is fetched.
  let accumulatedBytes = 0;
  let budgetReached = false;
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length && !budgetReached) {
      const idx = cursor++;
      const id = ids[idx];
      try {
        const r = await withGoogleRetry(
          () =>
            gmail.users.messages.get(
              { userId: "me", id, format: "raw" },
              { timeout: MAILBOX_API_TIMEOUT_MS }
            ),
          { retryServerErrors: true }
        );
        // A message with no raw body (e.g. a Chat / structured item) can't be
        // re-imported, so record it as skipped rather than writing an empty,
        // unimportable line that the importer would later count as a failure.
        if (!r.data.raw) {
          skipped.push({ id, error: "Message has no exportable raw content" });
          continue;
        }
        messages[idx] = {
          id: r.data.id || id,
          threadId: r.data.threadId || "",
          internalDate: r.data.internalDate ?? null,
          labelIds: r.data.labelIds || [],
          sizeEstimate: r.data.sizeEstimate ?? 0,
          raw: r.data.raw,
        };
        accumulatedBytes += r.data.raw.length;
        if (accumulatedBytes >= MAILBOX_EXPORT_PAGE_BYTE_BUDGET) {
          // Stop starting new fetches; in-flight ones finish and fill their
          // (contiguous, lower) indices before the pool drains.
          budgetReached = true;
        }
      } catch (e) {
        // Don't let one unfetchable message abort the whole mailbox export —
        // record it and move on.
        skipped.push({ id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAILBOX_EXPORT_FETCH_CONCURRENCY, ids.length || 1) },
      worker
    )
  );

  // Ids never claimed (cursor points past the last claimed index) roll over to
  // the next call. Claims are sequential, so this tail is exactly the unfetched
  // remainder of the current list page.
  const pendingIds = cursor < ids.length ? ids.slice(cursor) : null;

  const page: MailboxExportPage = {
    user: userEmail.toLowerCase(),
    messages: messages.filter((m): m is ExportedMessage => !!m),
    skipped,
    nextPageToken: listNextPageToken,
    resultSizeEstimate,
    pendingIds,
  };
  // Labels belong on the first call only (no pageToken and not a continuation).
  if (!opts.pageToken && !continuing) {
    page.labels = await listGmailLabels(tenant, userEmail);
  }
  return page;
}

/**
 * Resolve the source mailbox's labels to label IDs in the target mailbox,
 * creating any missing user labels by name.
 *
 * System labels (INBOX, SENT, IMPORTANT, CATEGORY_*, …) use IDs that are
 * identical across every mailbox, so they map to themselves. User labels have
 * arbitrary per-mailbox IDs, so we match on (case-insensitive) name and create
 * the label when the target doesn't have it yet. Returns a `{ sourceId:
 * targetId }` map the caller applies to each message's labelIds before import.
 */
export async function resolveImportLabels(
  tenant: Tenant | null,
  userEmail: string,
  sourceLabels: GmailLabelInfo[]
): Promise<Record<string, string>> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }
  if (!Array.isArray(sourceLabels)) {
    throw new Error("sourceLabels must be an array");
  }

  const gmail = buildGmailClient(tenant, userEmail, GMAIL_LABELS_SCOPES);

  // Only USER labels are matched/created by name. System labels are excluded
  // from this map so a source user-label literally named "Important" (or
  // "Inbox", "Sent", …) can never be remapped onto the target's IMPORTANT/
  // INBOX/SENT system label — which would silently force-mark or un-archive
  // every message that carried it.
  const byNameLower = new Map<string, string>();
  const refreshExisting = async () => {
    const res = await withGoogleRetry(
      () =>
        gmail.users.labels.list(
          { userId: "me" },
          { timeout: MAILBOX_API_TIMEOUT_MS }
        ),
      { retryServerErrors: true }
    );
    byNameLower.clear();
    for (const l of res.data.labels || []) {
      if (l.id && l.name && (l.type || "") !== "system") {
        byNameLower.set(l.name.toLowerCase(), l.id);
      }
    }
  };
  await refreshExisting();

  const map: Record<string, string> = {};
  // Labels that need an API round trip (create, or conflict-resolve). Mapped
  // sequentially below only in the cheap in-memory cases.
  const pending: Array<{ sourceId: string; name: string; nameLower: string }> =
    [];
  for (const sl of sourceLabels) {
    const sourceId = sl?.id;
    if (!sourceId || !GMAIL_LABEL_ID_RE.test(sourceId)) continue;

    // System labels share IDs across mailboxes — map straight through. Decide
    // this from the known ID set, not the file-supplied `type`.
    if (SYSTEM_LABEL_IDS.has(sourceId)) {
      map[sourceId] = sourceId;
      continue;
    }

    // Reject empty or implausibly long names before calling create — Gmail
    // caps label names at 225 chars, so anything longer is junk from a
    // malformed/crafted export and would only waste a failing API round trip.
    const name = (sl.name || "").trim();
    if (!name || name.length > 225) continue;
    const nameLower = name.toLowerCase();

    const existing = byNameLower.get(nameLower);
    if (existing) {
      map[sourceId] = existing;
      continue;
    }
    pending.push({ sourceId, name, nameLower });
  }

  // Share one in-flight re-list between concurrently conflicting workers.
  let refreshing: Promise<void> | null = null;
  const refreshOnce = () => {
    if (!refreshing) {
      refreshing = refreshExisting().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  };

  // Create missing labels with bounded concurrency: creates are independent,
  // and a serial walk turns a label-heavy mailbox (Gmail allows up to 10,000)
  // into a minutes-long stall of the labels route. Conflicts from duplicate
  // names in flight resolve through the shared re-list below, exactly like the
  // serial version did.
  const LABEL_CREATE_CONCURRENCY = 5;
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      // An earlier worker may have created this name (case-variant duplicates
      // in the export) — map without another round trip.
      const existing = byNameLower.get(item.nameLower);
      if (existing) {
        map[item.sourceId] = existing;
        continue;
      }
      try {
        // Safe to retry server errors: a 5xx that actually created the label
        // surfaces as a 409 on the retry, which the catch below turns into a
        // re-list + map rather than a duplicate.
        const created = await withGoogleRetry(
          () =>
            gmail.users.labels.create(
              {
                userId: "me",
                requestBody: {
                  name: item.name,
                  labelListVisibility: "labelShow",
                  messageListVisibility: "show",
                },
              },
              { timeout: MAILBOX_API_TIMEOUT_MS }
            ),
          { retryServerErrors: true }
        );
        if (created.data.id) {
          map[item.sourceId] = created.data.id;
          byNameLower.set(item.nameLower, created.data.id);
        }
      } catch (e) {
        // A racing create (or a name that already exists under a different case)
        // surfaces as a conflict — re-list and map to whatever now exists.
        if (isAlreadyExistsError(e)) {
          await refreshOnce();
          const now = byNameLower.get(item.nameLower);
          if (now) map[item.sourceId] = now;
        }
        // Any other failure: skip this label. The message still imports, just
        // without this one tag (import is resilient by design).
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(LABEL_CREATE_CONCURRENCY, pending.length || 1) },
      worker
    )
  );
  return map;
}

export interface ImportMessageInput {
  raw: string;
  labelIds?: string[];
}

export interface ImportBatchResult {
  inserted: number;
  failed: number;
  errors: Array<{ index: number; message: string }>;
}

// A real message carries a handful of labels; cap the array so a crafted
// export can't attach a huge label list to inflate the insert payload.
const MAX_LABELS_PER_MESSAGE = 100;

/** Drop label IDs that are malformed or can't be applied on insert. */
function sanitizeImportLabelIds(labelIds: unknown): string[] {
  if (!Array.isArray(labelIds)) return [];
  const out: string[] = [];
  for (const l of labelIds) {
    if (out.length >= MAX_LABELS_PER_MESSAGE) break;
    if (typeof l !== "string") continue;
    if (!GMAIL_LABEL_ID_RE.test(l)) continue;
    if (NON_IMPORTABLE_LABELS.has(l)) continue;
    out.push(l);
  }
  return out;
}

/**
 * Insert a batch of raw messages into `userEmail`'s mailbox.
 *
 * Uses messages.insert (IMAP-APPEND semantics): the message is added directly
 * without re-delivery or spam reclassification, and `internalDateSource:
 * "dateHeader"` keeps each message ordered by its original Date header rather
 * than "now". Per-message failures are collected, never thrown, so one bad
 * message doesn't abort the batch. A message that fails because of a label is
 * retried once with no labels, so a stale/unknown label can't lose the mail.
 */
export async function importMessageBatch(
  tenant: Tenant | null,
  userEmail: string,
  messages: ImportMessageInput[]
): Promise<ImportBatchResult> {
  if (!isValidEmail(userEmail)) {
    throw new Error("userEmail must be a valid email address");
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  if (messages.length > MAILBOX_IMPORT_BATCH_CAP) {
    throw new Error(
      `Too many messages in one import batch — cap is ${MAILBOX_IMPORT_BATCH_CAP}`
    );
  }

  const gmail = buildGmailClient(tenant, userEmail, GMAIL_INSERT_SCOPES);
  const out: ImportBatchResult = { inserted: 0, failed: 0, errors: [] };

  const insertOne = async (i: number): Promise<void> => {
    const raw = typeof messages[i]?.raw === "string" ? messages[i].raw : "";
    if (!raw) {
      out.failed++;
      out.errors.push({ index: i, message: "Message has no raw content" });
      return;
    }
    if (raw.length > MAILBOX_MAX_RAW_CHARS) {
      out.failed++;
      out.errors.push({ index: i, message: "Message exceeds the size limit" });
      return;
    }
    const labelIds = sanitizeImportLabelIds(messages[i].labelIds);

    try {
      // 429-only retry: insert is NOT idempotent, so a 5xx (which might have
      // committed the message) must surface as a failure rather than risk a
      // duplicate on a blind retry. Rate-limit rejections never reach Gmail's
      // store, so backing off and retrying those is safe.
      await withGoogleRetry(
        () =>
          gmail.users.messages.insert(
            {
              userId: "me",
              internalDateSource: "dateHeader",
              requestBody: {
                raw,
                labelIds: labelIds.length ? labelIds : undefined,
              },
            },
            { timeout: MAILBOX_API_TIMEOUT_MS }
          ),
        { retryServerErrors: false }
      );
      out.inserted++;
    } catch (e) {
      // Retry once with no labels — the most common insert rejection is an
      // unapplicable label. But ONLY when the first attempt definitely did not
      // commit: a 4xx (other than 429) is a clean rejection by Gmail, so the
      // message was never stored and re-inserting can't duplicate it. A 5xx,
      // timeout, or network error is ambiguous — the message may have
      // committed before the response was lost — so we must NOT re-insert, or
      // we'd silently store a duplicate (messages.insert has no dedup key).
      const status = httpStatusOf(e);
      const cleanlyRejected =
        labelIds.length > 0 &&
        status !== null &&
        status >= 400 &&
        status < 500 &&
        status !== 429;
      if (cleanlyRejected) {
        try {
          await withGoogleRetry(
            () =>
              gmail.users.messages.insert(
                {
                  userId: "me",
                  internalDateSource: "dateHeader",
                  requestBody: { raw },
                },
                { timeout: MAILBOX_API_TIMEOUT_MS }
              ),
            { retryServerErrors: false }
          );
          out.inserted++;
          return;
        } catch (e2) {
          out.failed++;
          out.errors.push({
            index: i,
            message: e2 instanceof Error ? e2.message : String(e2),
          });
          return;
        }
      }
      out.failed++;
      out.errors.push({
        index: i,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // Insert with bounded concurrency. Each message is independent and insert
  // order doesn't matter (dates come from each message's own header), so a small
  // worker pool roughly triples throughput over a serial loop while staying well
  // under Gmail's insert quota (~10 inserts/user/sec). The per-message failure
  // isolation and no-blind-retry duplicate protection above are unchanged, and
  // the synchronous counter/array mutations can't interleave mid-statement.
  let cursor = 0;
  const worker = async () => {
    while (cursor < messages.length) {
      await insertOne(cursor++);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAILBOX_IMPORT_INSERT_CONCURRENCY, messages.length) },
      worker
    )
  );

  return out;
}
