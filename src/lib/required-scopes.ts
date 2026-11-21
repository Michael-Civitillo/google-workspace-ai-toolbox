/**
 * Every Google permission (OAuth scope) Open Admin uses, and every Google
 * Cloud API that has to be switched on for them to work.
 *
 * The one list. The scope check, the Setup page and the Get Started wizard
 * all read it, so a feature that needs a new permission adds it here once
 * and all three ask for it. Before this file each kept its own copy, and the
 * two pages had fallen two scopes behind the check.
 *
 * No imports: both server and browser code use it.
 */
export interface RequiredScope {
  scope: string;
  /** Short display name. */
  label: string;
  /** What this scope unlocks, so the operator knows what's at risk. */
  feature: string;
}

export const REQUIRED_SCOPES: readonly RequiredScope[] = [
  {
    scope: "https://www.googleapis.com/auth/admin.directory.user",
    label: "Directory user",
    feature: "User lookup, suspension, primary-email change, Security Check (sign-in facts)",
  },
  {
    scope: "https://www.googleapis.com/auth/admin.directory.user.security",
    label: "Directory user security",
    feature: "OAuth token revoke, force sign-out (offboarding), Security Check (connected apps)",
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
    scope: "https://www.googleapis.com/auth/apps.licensing",
    label: "Licences",
    feature: "Licences page: who holds which licence, assign and remove",
  },
  {
    scope: "https://www.googleapis.com/auth/admin.reports.audit.readonly",
    label: "Reports (audit, read)",
    feature:
      "Sign-in/admin activity reports + AI security digest, Security Check (domain-wide delegation)",
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
    feature: "Email delegation setup + delegate lookup, Security Check (forwarding)",
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
];

/** The APIs to enable in the Google Cloud project the key belongs to. */
export const REQUIRED_APIS: ReadonlyArray<{ name: string; feature: string }> = [
  { name: "Gmail API", feature: "Delegation, forwarding, mailbox export and import" },
  { name: "Google Calendar API", feature: "Calendar delegation and transfer" },
  { name: "Admin SDK API", feature: "Users, groups, domains, activity reports" },
  { name: "Admin Data Transfer API", feature: "Offboarding: Drive ownership transfer" },
  { name: "Google Drive API", feature: "Sharing Audit, Drive Transfer" },
  { name: "Enterprise License Manager API", feature: "Licences" },
];
