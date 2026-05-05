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

const DRIVE_APP_ID = "55656082677"; // Drive & Docs application id for the Data Transfer API

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
  const res = await transfer.transfers.insert(
    {
      requestBody: {
        oldOwnerUserId: fromId,
        newOwnerUserId: toId,
        applicationDataTransfers: [
          {
            applicationId: DRIVE_APP_ID,
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
  truncated: boolean;
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
 * Caps at SHARING_AUDIT_FILE_CAP files scanned per call. For larger Drives,
 * the caller should paginate via the returned `truncated` flag and re-run.
 *
 * Drive metadata only — we never read file contents.
 */
export async function listExternallySharedFiles(
  tenant: Tenant | null,
  userEmail: string
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
  let pageToken: string | undefined = undefined;
  let truncated = false;

  while (scanned < SHARING_AUDIT_FILE_CAP) {
    const remaining = SHARING_AUDIT_FILE_CAP - scanned;
    const res: { data: drive_v3.Schema$FileList } = await drive.files.list(
      {
        // Files the user can see — focus on shared items only to keep the
        // audit cheap. `q="visibility != 'limited'"` would miss link-shared
        // items, so we use the broader filter and check permissions client-side.
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

  if (pageToken) truncated = true;

  return {
    user: userEmail.toLowerCase(),
    scannedFiles: scanned,
    truncated,
    files: matches,
  };
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
