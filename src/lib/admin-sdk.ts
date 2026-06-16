import { google, type drive_v3, type admin_directory_v1, type admin_datatransfer_v1 } from "googleapis";
import { readFileSync } from "fs";
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

const SCOPES = {
  USER: "https://www.googleapis.com/auth/admin.directory.user",
  USER_SECURITY:
    "https://www.googleapis.com/auth/admin.directory.user.security",
  DOMAIN_READONLY:
    "https://www.googleapis.com/auth/admin.directory.domain.readonly",
  DATA_TRANSFER: "https://www.googleapis.com/auth/admin.datatransfer",
  DRIVE_METADATA_READONLY:
    "https://www.googleapis.com/auth/drive.metadata.readonly",
  // Required to delete permissions. Google Drive does not expose a narrower
  // scope for permission management — `drive.file` only covers files the app
  // itself created, which doesn't help an admin tool acting on existing files.
  DRIVE_FULL: "https://www.googleapis.com/auth/drive",
} as const;

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

  const creds = JSON.parse(readFileSync(credFile, "utf-8"));
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes,
    subject,
  });
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
  const res = await client.users.get(
    { userKey: userEmail, projection: "full" },
    { timeout: ADMIN_API_TIMEOUT_MS }
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
    await client.users.get(
      { userKey: email, projection: "basic", fields: "primaryEmail" },
      { timeout: ADMIN_API_TIMEOUT_MS }
    );
    return true;
  } catch (e: unknown) {
    if (isNotFoundError(e)) return false;
    throw e;
  }
}

/** List all domains in the Google Workspace tenant. */
export async function listDomains(
  tenant: Tenant | null
): Promise<DomainInfo[]> {
  const { client } = getAdminClient(tenant);
  const res = await client.domains.list(
    { customer: "my_customer" },
    { timeout: ADMIN_API_TIMEOUT_MS }
  );

  return (res.data.domains || []).map((d) => ({
    domainName: (d.domainName || "").toLowerCase(),
    isPrimary: d.isPrimary || false,
    verified: d.verified || false,
  }));
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
  const res = await client.users.list(
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

  const exists = await userExists(tenant, currentEmail);
  if (!exists) {
    throw new Error(`No user found with email "${currentEmail}"`);
  }

  const conflict = await userExists(tenant, newEmail);
  if (conflict) {
    throw new Error(
      `"${newEmail}" is already in use by another user. Pick a different username or domain.`
    );
  }

  await client.users.update(
    {
      userKey: currentEmail,
      requestBody: { primaryEmail: newEmail },
    },
    { timeout: ADMIN_API_TIMEOUT_MS }
  );

  const after = await client.users.get(
    {
      userKey: newEmail,
      projection: "basic",
      fields: "primaryEmail",
    },
    { timeout: ADMIN_API_TIMEOUT_MS }
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
      "Refusing to suspend the admin this tool is impersonating — would lock the toolbox out."
    );
  }
  await client.users.update(
    {
      userKey: userEmail,
      requestBody: { suspended: true },
    },
    { timeout: ADMIN_API_TIMEOUT_MS }
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
  await client.users.signOut(
    { userKey: userEmail },
    { timeout: ADMIN_API_TIMEOUT_MS }
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
  const res = await client.tokens.list(
    { userKey: userEmail },
    { timeout: ADMIN_API_TIMEOUT_MS }
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
): Promise<{ revoked: number; failed: number }> {
  const tokens = await listOAuthTokens(tenant, userEmail);
  if (tokens.length === 0) return { revoked: 0, failed: 0 };
  const { client } = getAdminClient(tenant);
  let revoked = 0;
  let failed = 0;
  for (const t of tokens) {
    try {
      await client.tokens.delete(
        { userKey: userEmail, clientId: t.clientId },
        { timeout: ADMIN_API_TIMEOUT_MS }
      );
      revoked++;
    } catch {
      failed++;
    }
  }
  return { revoked, failed };
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

  const res = await transfer.applications.list(
    { customerId: "my_customer" },
    { timeout: ADMIN_API_TIMEOUT_MS }
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
    client.users.get(
      { userKey: fromUser, projection: "basic", fields: "id" },
      { timeout: ADMIN_API_TIMEOUT_MS }
    ),
    client.users.get(
      { userKey: toUser, projection: "basic", fields: "id" },
      { timeout: ADMIN_API_TIMEOUT_MS }
    ),
  ]);
  const fromId = fromU.data.id;
  const toId = toU.data.id;
  if (!fromId || !toId) {
    throw new Error("Could not resolve user IDs for Drive transfer");
  }

  const transfer = getDataTransferClient(tenant);
  const applicationId = await resolveDriveAppId(transfer);
  const res = await transfer.transfers.insert(
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

  const drive = getDriveClient(tenant, userEmail);

  const matches: ExternalSharedFile[] = [];
  let scanned = 0;
  let pageToken: string | undefined = startPageToken || undefined;

  while (scanned < SHARING_AUDIT_FILE_CAP) {
    const remaining = SHARING_AUDIT_FILE_CAP - scanned;
    const res: { data: drive_v3.Schema$FileList } = await drive.files.list(
      {
        // Files the user can see — focus on shared items only to keep the
        // audit cheap. `q="visibility != 'limited'"` would miss link-shared
        // items, so we use the broader filter and check permissions client-side.
        //
        // NOTE: the inline `permissions` field is capped by Drive at ~100
        // entries per file with no pagination here, so a file shared with more
        // than ~100 principals can under-report external permissions in the
        // audit. The revoke path (revokeForOneFile) re-lists permissions with
        // full pagination, so remediation is unaffected — only the audit
        // preview count can be short for pathologically over-shared files.
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
    );

    const files = res.data.files || [];
    for (const f of files) {
      scanned++;
      const externals: ExternalSharedFile["external"] = [];
      for (const p of f.permissions || []) {
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
const PATH_RESOLVE_FILE_CAP = 1000;

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
        const meta = await drive.files.get(
          {
            fileId: id,
            fields: "id, name, parents, driveId",
            supportsAllDrives: true,
          },
          { timeout: ADMIN_API_TIMEOUT_MS }
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
        const d = await drive.drives.get(
          { driveId },
          { timeout: ADMIN_API_TIMEOUT_MS }
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
      segments.unshift(folder.name);
      if (folder.parents.length === 0) {
        if (folder.driveId) {
          segments.unshift(await resolveDriveName(folder.driveId));
        } else {
          segments.unshift("My Drive");
        }
        break;
      }
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

function isNotFoundError(e: unknown): boolean {
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

  const drive = getDriveClientWritable(tenant, userEmail);
  // Built lazily inside the loop only if we actually need it — keeps the
  // common all-clean batch from doing an extra JWT exchange against
  // Google's auth servers.
  let adminDrive: drive_v3.Drive | null = null;
  const getAdminDrive = () => {
    if (!adminDrive) adminDrive = getDriveClientAsAdmin(tenant);
    return adminDrive;
  };

  const results: RevokeFileOutcome[] = [];
  for (const rawFileId of fileIds) {
    const fileId = String(rawFileId || "").trim();
    if (!fileId) continue;
    results.push(
      await revokeForOneFile(
        drive,
        getAdminDrive,
        fileId,
        verifiedDomains,
        allowedCategories
      )
    );
  }

  return { user: userEmail.toLowerCase(), results };
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
    const meta = await drive.files.get(
      {
        fileId,
        fields: "id, name",
        supportsAllDrives: true,
      },
      { timeout: ADMIN_API_TIMEOUT_MS }
    );
    fileName = meta.data.name ?? undefined;
    let pageToken: string | undefined;
    do {
      const r = await drive.permissions.list(
        {
          fileId,
          fields:
            "nextPageToken, permissions(id, type, role, emailAddress, domain, allowFileDiscovery)",
          pageSize: 100,
          pageToken,
          supportsAllDrives: true,
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
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

    try {
      await drive.permissions.delete(
        {
          fileId,
          permissionId: p.id,
          supportsAllDrives: true,
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
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
          await getAdminDrive().permissions.delete(
            {
              fileId,
              permissionId: p.id,
              supportsAllDrives: true,
              useDomainAdminAccess: true,
            },
            { timeout: ADMIN_API_TIMEOUT_MS }
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

  const res = await drive.files.list(
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
  );

  let parent: { id: string; name: string } | null = null;
  if (parentId) {
    try {
      const meta = await drive.files.get(
        { fileId: parentId, fields: "id, name" },
        { timeout: ADMIN_API_TIMEOUT_MS }
      );
      parent = {
        id: meta.data.id || parentId,
        name: meta.data.name || "(folder)",
      };
    } catch {
      parent = { id: parentId, name: "(folder)" };
    }
  }

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
  return { queue, current: null };
}

/**
 * Validate a cursor that came back from the client. Defensive: even though
 * the client only echoes what we sent, we never trust round-tripped state.
 */
function sanitizeCursor(cursor: unknown): DriveTransferCursor {
  if (typeof cursor !== "object" || cursor === null) {
    throw new Error("cursor must be an object");
  }
  const c = cursor as { queue?: unknown; current?: unknown };
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
  return { queue, current };
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
  };

  const out: DriveTransferProgress = {
    transferred: 0,
    alreadyOwned: 0,
    notOwned: 0,
    errors: [],
    nextCursor: null,
  };

  let budget = TRANSFER_BATCH_BUDGET;
  const toUserLower = toUser.toLowerCase();

  while (budget > 0) {
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
    const escapedParent = folderId.replace(/'/g, "\\'");
    const q = `'${escapedParent}' in parents and trashed = false and 'me' in owners`;
    const pageSize = Math.min(100, Math.max(1, budget));

    let listRes;
    try {
      listRes = await drive.files.list(
        {
          q,
          fields: "nextPageToken, files(id, name, mimeType)",
          pageSize,
          pageToken: local.current.pageToken ?? undefined,
          corpora: "user",
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
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

    for (const child of listRes.data.files || []) {
      const childId = child.id;
      if (!childId) continue;
      const result = await transferOneItem(drive, childId, toUserLower);
      applyTransferResult(out, childId, child.name ?? null, result);
      if (child.mimeType === DRIVE_FOLDER_MIME) {
        if (local.queue.length >= TRANSFER_QUEUE_HARD_CAP) {
          out.errors.push({
            id: childId,
            name: child.name ?? null,
            message:
              "Skipped: cursor queue hard cap reached — re-run after this chunk completes",
          });
        } else {
          local.queue.push(childId);
        }
      }
      budget--;
      if (budget === 0) break;
    }

    if (listRes.data.nextPageToken && budget > 0) {
      local.current.pageToken = listRes.data.nextPageToken;
    } else if (listRes.data.nextPageToken && budget === 0) {
      local.current.pageToken = listRes.data.nextPageToken;
      break;
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
  let perms: drive_v3.Schema$Permission[];
  try {
    const res = await drive.permissions.list(
      {
        fileId,
        fields: "permissions(id, type, role, emailAddress)",
        pageSize: 100,
        supportsAllDrives: true,
      },
      { timeout: ADMIN_API_TIMEOUT_MS }
    );
    perms = res.data.permissions || [];
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
      await drive.permissions.update(
        {
          fileId,
          permissionId: targetPerm.id,
          requestBody: { role: "owner" },
          transferOwnership: true,
          supportsAllDrives: true,
        },
        { timeout: ADMIN_API_TIMEOUT_MS }
      );
    } else {
      await drive.permissions.create(
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
      );
    }
    return { kind: "transferred" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isNotOwnerError(msg)) {
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
// Fetch a handful of raw messages in parallel per page — bounded so a page of
// large messages can't open dozens of simultaneous downloads.
const MAILBOX_EXPORT_FETCH_CONCURRENCY = 5;

/** Hard cap on messages accepted in a single import batch. */
export const MAILBOX_IMPORT_BATCH_CAP = 25;
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
   * The mailbox's labels. Returned only on the first page (no `pageToken`),
   * so the client can write them once into the export header.
   */
  labels?: GmailLabelInfo[];
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
  const res = await gmail.users.labels.list(
    { userId: "me" },
    { timeout: MAILBOX_API_TIMEOUT_MS }
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
 * each as its raw MIME blob with bounded concurrency. The first page (called
 * without a `pageToken`) also carries the label set so the client can record
 * it once in the export header. Read-only.
 */
export async function exportMailboxPage(
  tenant: Tenant | null,
  userEmail: string,
  opts: {
    pageToken?: string;
    pageSize?: number;
    includeSpamTrash?: boolean;
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

  const listRes = await gmail.users.messages.list(
    {
      userId: "me",
      maxResults: pageSize,
      pageToken: opts.pageToken,
      includeSpamTrash: opts.includeSpamTrash ?? false,
    },
    { timeout: MAILBOX_API_TIMEOUT_MS }
  );

  const ids = (listRes.data.messages || [])
    .map((m) => m.id)
    .filter((id): id is string => !!id);

  // Preserve list order in the output so the export reads in the same order
  // Gmail returned it (newest first), even though fetches complete out of order.
  const messages: (ExportedMessage | undefined)[] = new Array(ids.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const idx = cursor++;
      const id = ids[idx];
      const r = await gmail.users.messages.get(
        { userId: "me", id, format: "raw" },
        { timeout: MAILBOX_API_TIMEOUT_MS }
      );
      messages[idx] = {
        id: r.data.id || id,
        threadId: r.data.threadId || "",
        internalDate: r.data.internalDate ?? null,
        labelIds: r.data.labelIds || [],
        sizeEstimate: r.data.sizeEstimate ?? 0,
        raw: r.data.raw || "",
      };
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAILBOX_EXPORT_FETCH_CONCURRENCY, ids.length || 1) },
      worker
    )
  );

  const page: MailboxExportPage = {
    user: userEmail.toLowerCase(),
    messages: messages.filter((m): m is ExportedMessage => !!m),
    nextPageToken: listRes.data.nextPageToken || null,
    resultSizeEstimate: listRes.data.resultSizeEstimate ?? null,
  };
  if (!opts.pageToken) {
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
    const res = await gmail.users.labels.list(
      { userId: "me" },
      { timeout: MAILBOX_API_TIMEOUT_MS }
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
  for (const sl of sourceLabels) {
    const sourceId = sl?.id;
    if (!sourceId || !GMAIL_LABEL_ID_RE.test(sourceId)) continue;

    // System labels share IDs across mailboxes — map straight through. Decide
    // this from the known ID set, not the file-supplied `type`.
    if (SYSTEM_LABEL_IDS.has(sourceId)) {
      map[sourceId] = sourceId;
      continue;
    }

    const nameLower = (sl.name || "").toLowerCase();
    if (!nameLower) continue;

    const existing = byNameLower.get(nameLower);
    if (existing) {
      map[sourceId] = existing;
      continue;
    }

    try {
      const created = await gmail.users.labels.create(
        {
          userId: "me",
          requestBody: {
            name: sl.name,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          },
        },
        { timeout: MAILBOX_API_TIMEOUT_MS }
      );
      if (created.data.id) {
        map[sourceId] = created.data.id;
        byNameLower.set(nameLower, created.data.id);
      }
    } catch (e) {
      // A racing create (or a name that already exists under a different case)
      // surfaces as a conflict — re-list and map to whatever now exists.
      if (isAlreadyExistsError(e)) {
        await refreshExisting();
        const now = byNameLower.get(nameLower);
        if (now) map[sourceId] = now;
      }
      // Any other failure: skip this label. The message still imports, just
      // without this one tag (import is resilient by design).
    }
  }
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

/** Drop label IDs that are malformed or can't be applied on insert. */
function sanitizeImportLabelIds(labelIds: unknown): string[] {
  if (!Array.isArray(labelIds)) return [];
  const out: string[] = [];
  for (const l of labelIds) {
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

  for (let i = 0; i < messages.length; i++) {
    const raw = typeof messages[i]?.raw === "string" ? messages[i].raw : "";
    if (!raw) {
      out.failed++;
      out.errors.push({ index: i, message: "Message has no raw content" });
      continue;
    }
    if (raw.length > MAILBOX_MAX_RAW_CHARS) {
      out.failed++;
      out.errors.push({ index: i, message: "Message exceeds the size limit" });
      continue;
    }
    const labelIds = sanitizeImportLabelIds(messages[i].labelIds);

    try {
      await gmail.users.messages.insert(
        {
          userId: "me",
          internalDateSource: "dateHeader",
          requestBody: { raw, labelIds: labelIds.length ? labelIds : undefined },
        },
        { timeout: MAILBOX_API_TIMEOUT_MS }
      );
      out.inserted++;
    } catch (e) {
      // Retry once with no labels — by far the most common insert rejection is
      // an unapplicable label, and the mail itself is still worth saving.
      if (labelIds.length > 0) {
        try {
          await gmail.users.messages.insert(
            {
              userId: "me",
              internalDateSource: "dateHeader",
              requestBody: { raw },
            },
            { timeout: MAILBOX_API_TIMEOUT_MS }
          );
          out.inserted++;
          continue;
        } catch (e2) {
          out.failed++;
          out.errors.push({
            index: i,
            message: e2 instanceof Error ? e2.message : String(e2),
          });
          continue;
        }
      }
      out.failed++;
      out.errors.push({
        index: i,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return out;
}
