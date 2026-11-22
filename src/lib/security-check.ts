/**
 * Security Check: the shared types, and the rules that turn raw facts about a
 * tenant into findings.
 *
 * Everything here is pure: no I/O, no Node APIs, type-only imports at most. The
 * server scan (admin-sdk.ts) gathers the facts from Google, the page renders
 * the findings, and the unit tests exercise the rules, all against the same
 * definitions. A rule that lives in one place cannot drift between them, which
 * matters for a report people use to decide that nothing is wrong.
 */

import type { DomainEmailAuth, Verdict } from "./email-auth";

// ---------------------------------------------------------------------------
// Accounts: 2-Step Verification and inactivity
// ---------------------------------------------------------------------------

/** What the Directory API says about one account. */
export interface DirectoryAccount {
  primaryEmail: string;
  fullName: string;
  orgUnitPath: string;
  /** Super administrator. */
  isAdmin: boolean;
  /** Holds a delegated admin role. */
  isDelegatedAdmin: boolean;
  suspended: boolean;
  archived: boolean;
  enrolledIn2Sv: boolean;
  enforcedIn2Sv: boolean;
  /** ISO timestamp of the last interactive sign-in; null when never. */
  lastLoginTime: string | null;
  creationTime: string | null;
  /** False for an account with no Gmail mailbox (no Gmail licence). */
  mailboxSetup: boolean;
}

export interface TwoStepFinding {
  user: string;
  name: string;
  orgUnitPath: string;
  /** Super or delegated administrator: the accounts worth the most to steal. */
  admin: boolean;
}

export interface InactiveFinding {
  user: string;
  name: string;
  orgUnitPath: string;
  admin: boolean;
  /** Null when the account has never been signed in to. */
  lastLoginTime: string | null;
  creationTime: string | null;
  /**
   * Whole days since the last sign-in, or since the account was created when
   * it has never been used. Null only when Google reported neither date.
   */
  idleDays: number | null;
}

/**
 * The scan reports every account idle for at least this long, and the page
 * narrows from there. One scan then answers "90 days?" and "a year?" without
 * walking the tenant again.
 */
export const INACTIVE_FLOOR_DAYS = 30;
export const INACTIVE_DEFAULT_DAYS = 90;
export const INACTIVE_THRESHOLDS = [30, 90, 180, 365] as const;

const DAY_MS = 86_400_000;

/**
 * Google reports "never signed in" as the Unix epoch rather than leaving the
 * field out. Anything before 2000 is that sentinel (or garbage), not a date
 * someone signed in to a Workspace account.
 */
export function parseSignInTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || ms < Date.UTC(2000, 0, 1)) return null;
  return ms;
}

/** An account someone could sign in to: not suspended and not archived. */
export function isActiveAccount(account: DirectoryAccount): boolean {
  return !account.suspended && !account.archived;
}

export function isAdminAccount(account: DirectoryAccount): boolean {
  return account.isAdmin || account.isDelegatedAdmin;
}

export function twoStepFinding(account: DirectoryAccount): TwoStepFinding | null {
  if (!isActiveAccount(account) || account.enrolledIn2Sv) return null;
  return {
    user: account.primaryEmail,
    name: account.fullName,
    orgUnitPath: account.orgUnitPath,
    admin: isAdminAccount(account),
  };
}

/**
 * An active account nobody has signed in to for at least INACTIVE_FLOOR_DAYS.
 *
 * A never-used account is measured from its creation date, so someone who was
 * set up last week and has not started yet is not reported. When Google gives
 * neither date the account is reported with `idleDays: null`: "we cannot tell"
 * belongs in front of the operator, not silently among the healthy accounts.
 */
export function inactiveFinding(
  account: DirectoryAccount,
  now: number
): InactiveFinding | null {
  if (!isActiveAccount(account)) return null;
  const lastLogin = parseSignInTime(account.lastLoginTime);
  const since = lastLogin ?? parseSignInTime(account.creationTime);
  const idleDays = since === null ? null : Math.floor((now - since) / DAY_MS);
  if (idleDays !== null && idleDays < INACTIVE_FLOOR_DAYS) return null;
  return {
    user: account.primaryEmail,
    name: account.fullName,
    orgUnitPath: account.orgUnitPath,
    admin: isAdminAccount(account),
    lastLoginTime: lastLogin === null ? null : new Date(lastLogin).toISOString(),
    creationTime: account.creationTime,
    idleDays,
  };
}

/**
 * The most accounts one request may revoke an app for. The page sends larger
 * sets in batches, so a long list shows progress and can't time out.
 */
export const REVOKE_APP_BATCH = 25;

/** Does a reported account count as inactive at the chosen threshold? */
export function isInactiveAt(finding: InactiveFinding, thresholdDays: number): boolean {
  return finding.idleDays === null || finding.idleDays >= thresholdDays;
}

// ---------------------------------------------------------------------------
// Mail leaving the organisation
// ---------------------------------------------------------------------------

/** Gmail's auto-forwarding setting, as the API returns it. */
export interface RawAutoForwarding {
  enabled?: boolean | null;
  emailAddress?: string | null;
  disposition?: string | null;
}

/** One Gmail filter, as the API returns it (only the parts read here). */
export interface RawFilter {
  id?: string | null;
  criteria?: {
    from?: string | null;
    to?: string | null;
    subject?: string | null;
    query?: string | null;
    negatedQuery?: string | null;
    hasAttachment?: boolean | null;
  } | null;
  action?: {
    forward?: string | null;
    addLabelIds?: string[] | null;
    removeLabelIds?: string[] | null;
  } | null;
}

/**
 * What a forwarding filter does with the original besides forwarding it.
 * Deleting or archiving it means the mailbox owner may never see the mail
 * that went out, which is what makes forwarding hard to notice.
 */
function filterDisposition(action: RawFilter["action"]): { detail: string; hides: boolean } | null {
  const add = new Set((action?.addLabelIds ?? []).map((l) => String(l).toUpperCase()));
  const remove = new Set((action?.removeLabelIds ?? []).map((l) => String(l).toUpperCase()));
  if (add.has("TRASH")) return { detail: "deletes the original", hides: true };
  if (add.has("SPAM")) return { detail: "sends the original to spam", hides: true };
  if (remove.has("INBOX")) {
    return {
      detail: remove.has("UNREAD") ? "archives the original and marks it read" : "archives the original",
      hides: true,
    };
  }
  if (remove.has("UNREAD")) return { detail: "marks the original read", hides: false };
  return null;
}

export interface ForwardingFinding {
  user: string;
  name: string;
  /** The mailbox-wide setting, or a filter that forwards what it matches. */
  kind: "auto-forward" | "filter";
  target: string;
  /**
   * For auto-forwarding, what happens to the original. For a filter, what it
   * matches. Already worded for display.
   */
  detail: string;
  /**
   * The original is deleted or hidden after forwarding: the shape a mailbox
   * takes when someone wants a copy of the mail without the owner noticing.
   */
  hidesOriginal: boolean;
  /** Gmail's id for the filter, when this finding is a filter. */
  filterId: string | null;
}

/**
 * Is this address outside the organisation's verified domains?
 *
 * Fails closed: anything that does not parse as `local@domain` is treated as
 * external, the same rule isExternalTarget applies to transfers.
 */
export function isExternalAddress(
  address: string,
  verifiedDomains: ReadonlySet<string>
): boolean {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return true;
  return !verifiedDomains.has(trimmed.slice(at + 1));
}

const DISPOSITIONS: Record<string, { detail: string; hides: boolean }> = {
  leaveInInbox: { detail: "keeps the original in the inbox", hides: false },
  markRead: { detail: "marks the original as read", hides: false },
  archive: { detail: "archives the original", hides: true },
  trash: { detail: "deletes the original", hides: true },
};

/** A filter's criteria in Gmail's own search syntax, or "all incoming mail". */
export function describeFilterCriteria(criteria: RawFilter["criteria"]): string {
  if (!criteria) return "all incoming mail";
  const parts: string[] = [];
  if (criteria.from) parts.push(`from:${criteria.from}`);
  if (criteria.to) parts.push(`to:${criteria.to}`);
  if (criteria.subject) parts.push(`subject:${criteria.subject}`);
  if (criteria.query) parts.push(criteria.query);
  if (criteria.negatedQuery) parts.push(`-{${criteria.negatedQuery}}`);
  if (criteria.hasAttachment) parts.push("has:attachment");
  return parts.length > 0 ? parts.join(" ") : "all incoming mail";
}

/**
 * Everything in one mailbox that sends mail outside the organisation, plus a
 * count of the forwards that stay inside it (context, not a finding).
 */
export function forwardingFindings(
  owner: { primaryEmail: string; fullName: string },
  autoForwarding: RawAutoForwarding | null,
  filters: readonly RawFilter[],
  verifiedDomains: ReadonlySet<string>
): { external: ForwardingFinding[]; internal: number } {
  const external: ForwardingFinding[] = [];
  let internal = 0;

  const target = autoForwarding?.emailAddress?.trim();
  if (autoForwarding?.enabled && target) {
    if (isExternalAddress(target, verifiedDomains)) {
      const disposition = DISPOSITIONS[autoForwarding.disposition ?? ""];
      external.push({
        user: owner.primaryEmail,
        name: owner.fullName,
        kind: "auto-forward",
        target: target.toLowerCase(),
        detail: `Forwards all mail; ${disposition?.detail ?? "keeps the original"}`,
        hidesOriginal: disposition?.hides ?? false,
        filterId: null,
      });
    } else {
      internal++;
    }
  }

  for (const filter of filters) {
    const forward = filter.action?.forward?.trim();
    if (!forward) continue;
    if (isExternalAddress(forward, verifiedDomains)) {
      const disposition = filterDisposition(filter.action);
      external.push({
        user: owner.primaryEmail,
        name: owner.fullName,
        kind: "filter",
        target: forward.toLowerCase(),
        detail: `Filter on ${describeFilterCriteria(filter.criteria)}${
          disposition ? `; ${disposition.detail}` : ""
        }`,
        hidesOriginal: disposition?.hides ?? false,
        filterId: filter.id ?? null,
      });
    } else {
      internal++;
    }
  }

  return { external, internal };
}

// ---------------------------------------------------------------------------
// Connected apps
// ---------------------------------------------------------------------------

export type AccessLevel = "high" | "medium" | "low";

export interface ScopeInfo {
  level: AccessLevel;
  /** What the scope reaches, in a word or two: "Gmail", "Drive", "Sign-in". */
  area: string;
}

const AUTH = "https://www.googleapis.com/auth/";

/**
 * The scopes Google itself classes as "restricted" (an app needs a security
 * assessment to request them from the public), plus anything that reaches the
 * admin console or the cloud project. These read or change mail, every file in
 * Drive, or the tenant's configuration.
 */
const HIGH_EXACT: Record<string, string> = {
  "https://mail.google.com": "Gmail",
  [`${AUTH}gmail.readonly`]: "Gmail",
  [`${AUTH}gmail.modify`]: "Gmail",
  [`${AUTH}gmail.compose`]: "Gmail",
  [`${AUTH}gmail.insert`]: "Gmail",
  [`${AUTH}gmail.metadata`]: "Gmail",
  [`${AUTH}gmail.settings.basic`]: "Gmail settings",
  [`${AUTH}gmail.settings.sharing`]: "Gmail settings",
  [`${AUTH}drive`]: "Drive",
  [`${AUTH}drive.readonly`]: "Drive",
  [`${AUTH}drive.activity`]: "Drive",
  [`${AUTH}drive.activity.readonly`]: "Drive",
  [`${AUTH}drive.metadata`]: "Drive",
  [`${AUTH}drive.metadata.readonly`]: "Drive",
  [`${AUTH}drive.meet.readonly`]: "Drive",
  [`${AUTH}drive.scripts`]: "Drive",
  [`${AUTH}cloud-platform`]: "Google Cloud",
  [`${AUTH}cloud-platform.read-only`]: "Google Cloud",
  [`${AUTH}ediscovery`]: "Vault",
  [`${AUTH}ediscovery.readonly`]: "Vault",
  [`${AUTH}apps.groups.settings`]: "Admin console",
  [`${AUTH}apps.licensing`]: "Admin console",
};

/** Signing in, or reaching only what the user hands the app. */
const LOW_EXACT: Record<string, string> = {
  openid: "Sign-in",
  email: "Sign-in",
  profile: "Sign-in",
  [`${AUTH}userinfo.email`]: "Sign-in",
  [`${AUTH}userinfo.profile`]: "Sign-in",
  [`${AUTH}drive.file`]: "Files opened with the app",
  [`${AUTH}drive.appdata`]: "Its own app data",
  [`${AUTH}drive.appfolder`]: "Its own app data",
  [`${AUTH}drive.install`]: "Its own app data",
  [`${AUTH}gmail.labels`]: "Gmail labels",
};

/** Broad access to one product, short of mail and the whole of Drive. */
const MEDIUM_PREFIX: Array<[string, string]> = [
  [`${AUTH}gmail.send`, "Send mail"],
  [`${AUTH}calendar`, "Calendar"],
  [`${AUTH}contacts`, "Contacts"],
  ["https://www.google.com/m8/feeds", "Contacts"],
  [`${AUTH}directory.readonly`, "Contacts"],
  [`${AUTH}documents`, "Docs, Sheets, Slides"],
  [`${AUTH}spreadsheets`, "Docs, Sheets, Slides"],
  [`${AUTH}presentations`, "Docs, Sheets, Slides"],
  [`${AUTH}forms`, "Forms"],
  [`${AUTH}tasks`, "Tasks"],
  [`${AUTH}chat`, "Chat"],
  [`${AUTH}script`, "Apps Script"],
  [`${AUTH}user.`, "Profile details"],
];

function titleCase(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

/**
 * What one OAuth scope lets an app do, at the resolution an admin needs:
 * can it read the mail and the files, or not.
 *
 * A scope this table does not know is "medium": it reaches some product's
 * data, and an unrecognised permission is not a reason to call an app
 * harmless. The raw scope is always shown alongside, so nothing is hidden by
 * the summary.
 */
export function classifyScope(scope: string): ScopeInfo {
  const s = scope.trim().toLowerCase().replace(/\/+$/, "");

  const high = HIGH_EXACT[s];
  if (high) return { level: "high", area: high };
  if (s.startsWith(`${AUTH}admin.`)) return { level: "high", area: "Admin console" };
  if (s.startsWith("https://apps-apis.google.com/")) {
    return { level: "high", area: "Admin console" };
  }

  const low = LOW_EXACT[s];
  if (low) return { level: "low", area: low };
  // Add-on scopes limited to the message or document that is open.
  if (s.endsWith(".currentonly") || s.includes(".addons.current.")) {
    return { level: "low", area: "The open item only" };
  }

  for (const [prefix, area] of MEDIUM_PREFIX) {
    if (s === prefix || s.startsWith(prefix)) return { level: "medium", area };
  }

  if (s.startsWith(AUTH)) {
    const product = s.slice(AUTH.length).split(/[./]/)[0];
    return { level: "medium", area: titleCase(product) || "Other" };
  }
  return { level: "medium", area: "Other" };
}

/** One app and the people who granted it access. */
export interface AppGrant {
  clientId: string;
  /** The name the app gave Google. Not verified: an app can call itself anything. */
  name: string;
  scopes: string[];
  /** Registered anonymously with Google. */
  anonymous: boolean;
  /** An installed (desktop or mobile) application rather than a web service. */
  nativeApp: boolean;
  users: string[];
}

const LEVEL_RANK: Record<AccessLevel, number> = { high: 2, medium: 1, low: 0 };

/** The most an app can reach, and where, strongest access first. */
export function summariseAccess(scopes: readonly string[]): {
  level: AccessLevel;
  areas: Array<{ area: string; level: AccessLevel }>;
} {
  const strongest = new Map<string, AccessLevel>();
  for (const scope of scopes) {
    const { level, area } = classifyScope(scope);
    const known = strongest.get(area);
    if (!known || LEVEL_RANK[level] > LEVEL_RANK[known]) strongest.set(area, level);
  }
  const areas = [...strongest]
    .map(([area, level]) => ({ area, level }))
    .sort(
      (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.area.localeCompare(b.area)
    );
  return { level: areas[0]?.level ?? "low", areas };
}

/**
 * Fold one page of grants into the running total. Keyed by client id, which is
 * what identifies an app to Google: two apps can share a name, and one that
 * imitates a well-known name must not be merged into the real one.
 */
export function mergeAppGrants(
  total: Map<string, AppGrant>,
  page: readonly AppGrant[]
): Map<string, AppGrant> {
  for (const grant of page) {
    const existing = total.get(grant.clientId);
    if (!existing) {
      total.set(grant.clientId, {
        ...grant,
        scopes: [...new Set(grant.scopes)].sort(),
        users: [...new Set(grant.users)].sort(),
      });
      continue;
    }
    existing.scopes = [...new Set([...existing.scopes, ...grant.scopes])].sort();
    existing.users = [...new Set([...existing.users, ...grant.users])].sort();
    existing.anonymous = existing.anonymous || grant.anonymous;
    existing.nativeApp = existing.nativeApp || grant.nativeApp;
    if (!existing.name && grant.name) existing.name = grant.name;
  }
  return total;
}

/** Most access first, then most people, then by name. */
export function compareApps(a: AppGrant, b: AppGrant): number {
  return (
    LEVEL_RANK[summariseAccess(b.scopes).level] - LEVEL_RANK[summariseAccess(a.scopes).level] ||
    b.users.length - a.users.length ||
    a.name.localeCompare(b.name)
  );
}

// ---------------------------------------------------------------------------
// Domain-wide delegation
// ---------------------------------------------------------------------------

/**
 * How far back the admin log is asked for delegation changes. Google keeps
 * admin log events for about six months; asking for more returns the same.
 */
export const DELEGATION_WINDOW_DAYS = 180;

/** One entry from the admin log: delegation granted to a client, or removed. */
export interface DelegationEvent {
  /** RFC3339 time of the change. */
  time: string;
  /** The administrator who made it. */
  actor: string;
  kind: "authorize" | "remove";
  /** The API client the change is about: a service account or OAuth client id. */
  clientId: string;
  /** Scopes granted. Empty for a removal. */
  scopes: string[];
}

/**
 * What the admin log says about one client with domain-wide delegation.
 *
 * This is a reading of the log, not of Google's configuration: Google offers
 * no way for an app to read the delegation list itself. A client granted
 * before the log's window and untouched since does not appear at all.
 */
export interface DelegatedClient {
  clientId: string;
  /** Its most recent change in the window was a grant, or a removal. */
  status: "authorized" | "removed";
  /** Scopes from its most recent grant in the window. */
  scopes: string[];
  lastChange: string;
  lastActor: string;
  /** This is Open Admin's own service account. */
  ownApp: boolean;
  /**
   * For Open Admin's own client only: scopes it was granted that it never
   * asks for. Every unused scope is reach that a stolen key would have for
   * nothing.
   */
  unusedScopes: string[];
  /** Every change in the window, newest first. */
  history: DelegationEvent[];
}

/**
 * The scope list from an admin log parameter. Google may send it as one
 * string or as a list, separated by commas, spaces or new lines; all of those
 * mean the same thing.
 */
export function parseScopeList(
  value: string | readonly string[] | null | undefined
): string[] {
  if (!value) return [];
  const pieces = typeof value === "string" ? [value] : value;
  const scopes = pieces
    .flatMap((piece) => String(piece).split(/[\s,]+/))
    .map((scope) => scope.trim())
    .filter(Boolean);
  return [...new Set(scopes)];
}

/** The same scope, however it was typed into the Admin console. */
function scopeKey(scope: string): string {
  return scope.trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * Turn the admin log's delegation changes into one entry per client.
 *
 * A client's most recent change decides whether it is authorised now, and its
 * most recent grant decides its scopes: the Admin console replaces a client's
 * scope list when it is edited, so a later grant supersedes an earlier one.
 *
 * Authorised clients come first, widest access first; among equals, the most
 * recently changed. Open Admin's own client is listed like any other, marked,
 * with the scopes it holds but never uses.
 */
export function summariseDelegation(
  events: readonly DelegationEvent[],
  opts: { ownClientId: string | null; usedScopes: readonly string[] }
): DelegatedClient[] {
  const byClient = new Map<string, DelegationEvent[]>();
  for (const event of events) {
    const clientId = event.clientId.trim();
    if (!clientId) continue;
    const list = byClient.get(clientId) ?? [];
    list.push({ ...event, clientId });
    byClient.set(clientId, list);
  }

  const used = new Set(opts.usedScopes.map(scopeKey));
  const own = opts.ownClientId?.trim() || null;

  const clients: DelegatedClient[] = [];
  for (const [clientId, list] of byClient) {
    const history = [...list].sort((a, b) => b.time.localeCompare(a.time));
    const latest = history[0];
    const lastGrant = history.find((e) => e.kind === "authorize");
    const status = latest.kind === "authorize" ? "authorized" : "removed";
    const scopes = [...(lastGrant?.scopes ?? [])].sort();
    const ownApp = own !== null && clientId === own;
    clients.push({
      clientId,
      status,
      scopes,
      lastChange: latest.time,
      lastActor: latest.actor,
      ownApp,
      unusedScopes:
        ownApp && status === "authorized"
          ? scopes.filter((scope) => !used.has(scopeKey(scope)))
          : [],
      history,
    });
  }

  return clients.sort(
    (a, b) =>
      Number(b.status === "authorized") - Number(a.status === "authorized") ||
      LEVEL_RANK[summariseAccess(b.scopes).level] -
        LEVEL_RANK[summariseAccess(a.scopes).level] ||
      b.lastChange.localeCompare(a.lastChange) ||
      a.clientId.localeCompare(b.clientId)
  );
}

/**
 * Does this client deserve a second look?
 *
 * Any other app that currently holds delegation does: it can act as every
 * user, and the question "do we still need this?" is the whole point of the
 * check. Open Admin's own client is expected, and is a finding only when it
 * was granted more than it uses.
 */
export function delegationNeedsReview(client: DelegatedClient): boolean {
  if (client.status !== "authorized") return false;
  return client.ownApp ? client.unusedScopes.length > 0 : true;
}

/** What the delegation check returns. */
export interface DelegationReport {
  /** How many days of the admin log were read. */
  windowDays: number;
  clients: DelegatedClient[];
  /** True when the log held more changes than were read. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// What changed since the last scan
// ---------------------------------------------------------------------------

/** The checks, by the name the page and the history file use for them. */
export const CHECK_IDS = [
  "twoStep",
  "inactive",
  "forwarding",
  "apps",
  "delegation",
  "emailAuth",
] as const;
export type CheckName = (typeof CHECK_IDS)[number];

/**
 * A finished scan, reduced to what the next one needs in order to say what is
 * new: one short key per finding, and which checks actually ran. No names, no
 * scopes, nothing a key isn't.
 */
export interface ScanSnapshot {
  /** When the scan finished (ISO). */
  completedAt: string;
  keys: string[];
  /**
   * Checks that covered the tenant in that scan. A check that could not run
   * then has no baseline, and everything it finds now would look new; only
   * the checks listed here are compared.
   */
  covered: CheckName[];
}

/** More findings than this and the scan is not remembered at all. */
export const SNAPSHOT_MAX_KEYS = 200_000;

export const findingKey = {
  twoStep: (f: TwoStepFinding) => `2sv|${f.user}`,
  /**
   * One key per threshold the account has crossed, so "new" means new at the
   * threshold being looked at: an account that drifts from 80 to 95 idle days
   * is new at 90 without having been new at 30.
   */
  inactive: (f: InactiveFinding, thresholdDays: number) =>
    `idle${thresholdDays}|${f.user}`,
  forwarding: (f: ForwardingFinding) => `fwd|${f.user}|${f.kind}|${f.target}`,
  /** Includes how far the app reaches, so one that gains access counts as new. */
  app: (app: AppGrant) => `app|${app.clientId}|${summariseAccess(app.scopes).level}`,
  /** Includes the time of the change, so every grant or removal is new once. */
  delegation: (client: DelegatedClient) =>
    `dwd|${client.clientId}|${client.status}|${client.lastChange}`,
  /** One per record with something wrong, so a record that gets worse is new. */
  emailAuth: (domain: string, record: "spf" | "dkim" | "dmarc", verdict: Verdict) =>
    `mail|${domain}|${record}|${verdict}`,
};

/** The keys for one domain's email authentication problems. */
export function emailAuthKeys(d: DomainEmailAuth): string[] {
  return (["spf", "dkim", "dmarc"] as const)
    .filter((r) => ["bad", "warn", "unknown"].includes(d[r].verdict))
    .map((r) => findingKey.emailAuth(d.domain, r, d[r].verdict));
}

/** Every key a finished scan should be remembered by. */
export function snapshotKeys(found: {
  twoStep: readonly TwoStepFinding[];
  inactive: readonly InactiveFinding[];
  forwarding: readonly ForwardingFinding[];
  apps: readonly AppGrant[];
  delegated: readonly DelegatedClient[];
  domains?: readonly DomainEmailAuth[];
}): string[] {
  const keys = new Set<string>();
  for (const f of found.twoStep) keys.add(findingKey.twoStep(f));
  for (const f of found.inactive) {
    for (const days of INACTIVE_THRESHOLDS) {
      if (isInactiveAt(f, days)) keys.add(findingKey.inactive(f, days));
    }
  }
  for (const f of found.forwarding) keys.add(findingKey.forwarding(f));
  for (const app of found.apps) keys.add(findingKey.app(app));
  for (const client of found.delegated) keys.add(findingKey.delegation(client));
  for (const domain of found.domains ?? []) {
    for (const key of emailAuthKeys(domain)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * A snapshot read back from disk or from a request body, or null if it is not
 * one. Everything in it is treated as untrusted text.
 */
export function parseSnapshot(raw: unknown): ScanSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.completedAt !== "string" || Number.isNaN(Date.parse(r.completedAt))) {
    return null;
  }
  if (!Array.isArray(r.keys) || r.keys.length > SNAPSHOT_MAX_KEYS) return null;
  const keys: string[] = [];
  for (const key of r.keys) {
    if (typeof key !== "string" || key.length === 0 || key.length > 600) return null;
    keys.push(key);
  }
  const covered = Array.isArray(r.covered)
    ? CHECK_IDS.filter((id) => (r.covered as unknown[]).includes(id))
    : [];
  return { completedAt: new Date(r.completedAt).toISOString(), keys, covered };
}

// ---------------------------------------------------------------------------
// One page of a scan
// ---------------------------------------------------------------------------

export interface UnreadAccount {
  user: string;
  error: string;
}

/**
 * What one request to the scan returns: the findings for one page of the
 * tenant's accounts. The page chains requests on `nextPageToken` and adds the
 * pages up, so progress is visible and a scan can be cancelled part-way.
 */
export interface SecurityCheckPage {
  /** Accounts on this page, of any status. */
  accounts: number;
  /** Suspended or archived accounts: nobody can sign in, so they are skipped. */
  skippedSuspended: number;
  /** Active accounts, the ones every check below ran against. */
  activeAccounts: number;
  /** Active super and delegated administrators. */
  admins: number;

  withoutTwoStep: TwoStepFinding[];
  inactive: InactiveFinding[];

  /** Mailboxes whose forwarding settings were read (fully or in part). */
  mailboxesChecked: number;
  /** Active accounts with no Gmail mailbox to check. */
  withoutMailbox: number;
  externalForwarding: ForwardingFinding[];
  /** Forwards that stay inside the organisation. */
  internalForwards: number;
  mailboxErrors: UnreadAccount[];

  /** Accounts whose connected apps were read. */
  appsChecked: number;
  apps: AppGrant[];
  appErrors: UnreadAccount[];

  nextPageToken: string | null;
}
