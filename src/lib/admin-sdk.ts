import { google } from "googleapis";
import { readFileSync } from "fs";
import type { Tenant } from "./tenant-types";
import { isValidEmail, isValidDomain, isValidUsername } from "./validate";

const ADMIN_API_TIMEOUT_MS = 30_000;

/**
 * Get an authenticated Admin SDK Directory client for a specific tenant.
 *
 * Requires the Admin SDK Directory API enabled in GCP and domain-wide
 * delegation with these scopes:
 *   - https://www.googleapis.com/auth/admin.directory.user
 *   - https://www.googleapis.com/auth/admin.directory.domain.readonly
 */
function getAdminClient(tenant: Tenant | null, adminEmail?: string) {
  const credFile =
    tenant?.credentialsFile ||
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;

  if (!credFile) {
    throw new Error(
      "No credentials configured. Add a tenant on the Tenants page or set " +
        "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE."
    );
  }

  const subject =
    adminEmail || tenant?.adminEmail || process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL;
  if (!subject) {
    throw new Error(
      "No admin email configured for impersonation. Set one on the tenant or as GOOGLE_WORKSPACE_ADMIN_EMAIL."
    );
  }

  const creds = JSON.parse(readFileSync(credFile, "utf-8"));

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [
      "https://www.googleapis.com/auth/admin.directory.user",
      "https://www.googleapis.com/auth/admin.directory.domain.readonly",
    ],
    subject,
  });

  return {
    client: google.admin({ version: "directory_v1", auth }),
    impersonatedAdmin: subject.toLowerCase(),
  };
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

/**
 * Change a user's primary domain.
 *
 * Performs preflight checks before mutating:
 *   - target user exists
 *   - target user is NOT the admin we're impersonating (would lock us out)
 *   - new domain exists in the tenant and is verified
 *   - resulting email isn't already in use
 *
 * After the update we read the user back so the caller knows what Google
 * actually persisted, not what we intended.
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

  // Preflight: domain must exist and be verified.
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

  // Preflight: target user must exist.
  const exists = await userExists(tenant, currentEmail);
  if (!exists) {
    throw new Error(`No user found with email "${currentEmail}"`);
  }

  // Preflight: the new email must not already be in use.
  const conflict = await userExists(tenant, newEmail);
  if (conflict) {
    throw new Error(
      `"${newEmail}" is already in use by another user. Pick a different username or domain.`
    );
  }

  // Mutate.
  await client.users.update(
    {
      userKey: currentEmail,
      requestBody: { primaryEmail: newEmail },
    },
    { timeout: ADMIN_API_TIMEOUT_MS }
  );

  // Read-after-write: confirm what Google actually persisted.
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

function isNotFoundError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: number; status?: number; response?: { status?: number } };
  return (
    err.code === 404 ||
    err.status === 404 ||
    err.response?.status === 404
  );
}
