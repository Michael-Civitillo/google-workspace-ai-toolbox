import { google } from "googleapis";
import { readFileSync } from "fs";

/**
 * Get an authenticated Admin SDK Directory client.
 *
 * Uses the same service account credentials as the gws CLI
 * (via GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE env var).
 *
 * Requires the Admin SDK Directory API enabled in GCP and
 * domain-wide delegation with the scope:
 * https://www.googleapis.com/auth/admin.directory.user
 * https://www.googleapis.com/auth/admin.directory.domain.readonly
 */
function getAdminClient(adminEmail?: string) {
  const credFile = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;

  if (!credFile) {
    throw new Error(
      "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE is not set. " +
        "Point it to your service account JSON key file."
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
    // Service account needs to impersonate an admin to use Directory API
    subject: adminEmail || process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL,
  });

  return google.admin({ version: "directory_v1", auth });
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

/**
 * Look up a user by their email address.
 */
export async function getUser(userEmail: string): Promise<UserInfo> {
  const admin = getAdminClient();
  const res = await admin.users.get({
    userKey: userEmail,
    projection: "full",
  });

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
 * List all domains in the Google Workspace tenant.
 */
export async function listDomains(): Promise<DomainInfo[]> {
  const admin = getAdminClient();
  const res = await admin.domains.list({
    customer: "my_customer",
  });

  return (res.data.domains || []).map((d) => ({
    domainName: d.domainName || "",
    isPrimary: d.isPrimary || false,
    verified: d.verified || false,
  }));
}

/**
 * Change a user's primary domain.
 *
 * Takes the user's current email and the new target domain.
 * Constructs the new primary email by swapping the domain part.
 * Optionally allows specifying a custom username for the new address.
 */
export async function changePrimaryDomain(
  currentEmail: string,
  newDomain: string,
  newUsername?: string
): Promise<{ previousEmail: string; newEmail: string }> {
  const admin = getAdminClient();

  const username = newUsername || currentEmail.split("@")[0];
  const newEmail = `${username}@${newDomain}`;

  // Update the user's primary email
  await admin.users.update({
    userKey: currentEmail,
    requestBody: {
      primaryEmail: newEmail,
    },
  });

  return {
    previousEmail: currentEmail,
    newEmail,
  };
}
