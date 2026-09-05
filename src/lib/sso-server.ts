import {
  readFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  chmodSync,
  statSync,
} from "fs";
import path from "path";
import { isValidDomain, isValidEmail, ValidationError } from "./validate";
import {
  SSO_PROVIDERS,
  SSO_PROVIDER_PRESETS,
  SSO_CALLBACK_PATH,
  isLoopbackHost,
  type PublicSsoConfig,
  type SsoConfig,
  type SsoLoginStatus,
  type SsoProvider,
  type SsoTestRecord,
} from "./sso-types";

/**
 * Single sign-on configuration store.
 *
 * One JSON document (`sso.json` next to `tenants.json` by default, or wherever
 * SSO_CONFIG_PATH points) holding the OpenID Connect client the login page
 * uses. It contains the client secret, so the file is created 0600 and never
 * serialised to the browser in full — see toPublicSsoConfig().
 *
 * Writes follow the same tmp-file + fsync + rename discipline as the tenant
 * store, serialised through an in-process mutex, so a crash mid-write can't
 * leave a truncated file and concurrent requests can't lose each other's
 * changes.
 */
export const SSO_CONFIG_PATH = path.resolve(
  process.env.SSO_CONFIG_PATH || path.join(process.cwd(), "sso.json")
);
const STORE_TMP_PATH = `${SSO_CONFIG_PATH}.tmp`;

// Re-tighten permissions at module load: a file created by hand (or under a
// permissive umask by an older build) would otherwise keep exposing the client
// secret to other local users.
try {
  const stat = statSync(SSO_CONFIG_PATH);
  if ((stat.mode & 0o777) !== 0o600) chmodSync(SSO_CONFIG_PATH, 0o600);
} catch {
  // Not configured yet — the first write creates it with 0o600.
}

let writeLock: Promise<unknown> = Promise.resolve();

async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = writeLock;
  let release: () => void = () => {};
  writeLock = new Promise<void>((res) => {
    release = res;
  });
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}

function quarantineStore(): void {
  try {
    renameSync(SSO_CONFIG_PATH, `${SSO_CONFIG_PATH}.corrupt-${Date.now()}`);
  } catch {
    // Nothing more we can do; the read path already treats this as "no config".
  }
}

let warnedUnusable = false;

/**
 * Coerce whatever is on disk into a well-typed config, or null when required
 * fields are missing. Unknown keys are dropped, so a hand-edited file can't
 * smuggle values the validators never saw.
 */
function normalizeStored(raw: Record<string, unknown>): SsoConfig | null {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const list = (v: unknown): string[] =>
    Array.isArray(v)
      ? Array.from(
          new Set(
            v
              .filter((x): x is string => typeof x === "string")
              .map((x) => x.trim().toLowerCase())
              .filter(Boolean)
          )
        )
      : [];
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;

  const issuer = str(raw.issuer);
  const clientId = str(raw.clientId);
  const clientSecret = str(raw.clientSecret);
  const redirectUri = str(raw.redirectUri);
  if (!issuer || !clientId || !clientSecret || !redirectUri) return null;

  const provider: SsoProvider = SSO_PROVIDERS.includes(raw.provider as SsoProvider)
    ? (raw.provider as SsoProvider)
    : "generic";
  const now = new Date().toISOString();

  let lastTest: SsoTestRecord | undefined;
  if (raw.lastTest && typeof raw.lastTest === "object") {
    const t = raw.lastTest as Record<string, unknown>;
    if (typeof t.at === "string" && typeof t.ok === "boolean") {
      lastTest = { at: t.at, ok: t.ok };
      if (typeof t.email === "string") lastTest.email = t.email;
      if (typeof t.error === "string") lastTest.error = t.error;
    }
  }

  return {
    version: 1,
    enabled: bool(raw.enabled, false),
    provider,
    displayName: str(raw.displayName) ?? SSO_PROVIDER_PRESETS[provider].label,
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    allowedDomains: list(raw.allowedDomains),
    allowedEmails: list(raw.allowedEmails),
    allowAnyIdpUser: bool(raw.allowAnyIdpUser, false),
    passwordLoginEnabled: bool(raw.passwordLoginEnabled, true),
    createdAt: str(raw.createdAt) ?? now,
    updatedAt: str(raw.updatedAt) ?? now,
    lastTest,
  };
}

/** The stored configuration, or null when single sign-on was never set up. */
export function readSsoConfig(): SsoConfig | null {
  if (!existsSync(SSO_CONFIG_PATH)) return null;

  let raw: string;
  try {
    raw = readFileSync(SSO_CONFIG_PATH, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    // Transient read failures (EBUSY, EMFILE, antivirus locks) are not
    // corruption — surface them rather than quarantining a healthy file.
    throw new Error(
      `Failed to read SSO config at ${SSO_CONFIG_PATH}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  if (!raw.trim()) {
    quarantineStore();
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    quarantineStore();
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    quarantineStore();
    return null;
  }

  const cfg = normalizeStored(parsed as Record<string, unknown>);
  if (!cfg && !warnedUnusable) {
    warnedUnusable = true;
    console.warn(
      `[sso] ${SSO_CONFIG_PATH} is missing required fields (issuer, clientId, clientSecret, redirectUri) — ignoring it until it is re-saved from the SSO page.`
    );
  }
  return cfg;
}

async function writeStoreAtomic(cfg: SsoConfig): Promise<void> {
  const fd = openSync(STORE_TMP_PATH, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(cfg, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // Windows can transiently refuse the rename while antivirus or the search
  // indexer holds the destination open — retry briefly before giving up.
  const MAX_ATTEMPTS = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      renameSync(STORE_TMP_PATH, SSO_CONFIG_PATH);
      try {
        const dirFd = openSync(path.dirname(SSO_CONFIG_PATH), "r");
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch {
        // Directory fsync is unsupported on Windows — ignore.
      }
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt === MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
  try {
    if (existsSync(STORE_TMP_PATH)) unlinkSync(STORE_TMP_PATH);
  } catch {}
  throw lastError;
}

/** Strip the client secret before a config crosses to the browser. */
export function toPublicSsoConfig(cfg: SsoConfig): PublicSsoConfig {
  const { clientSecret, ...rest } = cfg;
  return { ...rest, hasClientSecret: Boolean(clientSecret) };
}

/**
 * Break-glass switch: APP_SSO_DISABLED=true turns single sign-on off (and
 * restores password login) without touching sso.json, for when the identity
 * provider is down or misconfigured and the admin is locked out.
 */
export function ssoDisabledByEnv(): boolean {
  return process.env.APP_SSO_DISABLED === "true";
}

/** Whether the login page should offer "Continue with …". */
export function ssoLoginAvailable(cfg: SsoConfig | null): cfg is SsoConfig {
  return Boolean(cfg && cfg.enabled && !ssoDisabledByEnv());
}

/**
 * Password login stays on unless single sign-on is live AND the admin chose to
 * turn the fallback off. Disabling SSO (by config or by env) always brings
 * the password form back so nobody can lock themselves out.
 */
export function passwordLoginEnabled(cfg: SsoConfig | null): boolean {
  if (!ssoLoginAvailable(cfg)) return true;
  return cfg.passwordLoginEnabled;
}

/** What the (unauthenticated) login page is allowed to know. */
export function getSsoLoginStatus(): SsoLoginStatus {
  let cfg: SsoConfig | null = null;
  try {
    cfg = readSsoConfig();
  } catch (e) {
    // A transient store read failure must not take the login page down:
    // degrade to password-only, which remains gated by APP_PASSWORD.
    console.error("[sso] could not read config for login status:", e);
  }
  const displayName = ssoLoginAvailable(cfg) ? cfg.displayName : null;
  return {
    ssoEnabled: displayName !== null,
    ssoDisplayName: displayName,
    passwordLoginEnabled: passwordLoginEnabled(cfg),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_URL_CHARS = 512;
const MAX_CLIENT_ID_CHARS = 512;
const MAX_SECRET_CHARS = 4096;
const MAX_DISPLAY_NAME_CHARS = 40;
const MAX_DOMAINS = 50;
const MAX_EMAILS = 500;

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }
  const s = value.trim();
  if (!s) throw new ValidationError(`${field} is required`);
  if (s.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(s)) {
    throw new ValidationError(`${field} contains control characters`);
  }
  return s;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${field} must be true or false`);
  }
  return value;
}

function parseUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`${field} must be an absolute URL`);
  }
  if (url.username || url.password) {
    throw new ValidationError(`${field} must not embed credentials`);
  }
  if (url.search || url.hash) {
    throw new ValidationError(`${field} must not contain a query string or fragment`);
  }
  return url;
}

/**
 * Issuer identifiers must be https: the token exchange carries the client
 * secret and the ID token. Plain http is tolerated only for loopback hosts so
 * a local development provider can be used.
 */
export function validateIssuer(value: unknown): string {
  const s = requireString(value, "issuer", MAX_URL_CHARS);
  const url = parseUrl(s, "issuer");
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopbackHost(url.hostname));
  if (!secure) {
    throw new ValidationError(
      "issuer must use https (plain http is only allowed for localhost)"
    );
  }
  // Discovery compares the document's `issuer` byte-for-byte with what was
  // typed. Providers publish path issuers without a trailing slash (Entra's
  // ".../v2.0", Okta's ".../oauth2/default"), so a pasted trailing slash
  // would fail with an opaque "issuer mismatch" — drop it. An origin-only
  // issuer keeps its root slash, which the URL parser normalises anyway.
  return url.pathname !== "/" && s.endsWith("/") ? s.replace(/\/+$/, "") : s;
}

/**
 * The redirect URI is what the provider sends the browser back to, so it must
 * point at this app's one callback handler. Non-loopback http is allowed to
 * match how Open Admin itself can be served in development, but providers
 * generally refuse to register it — the wizard warns about that.
 */
export function validateRedirectUri(value: unknown): string {
  const s = requireString(value, "redirectUri", MAX_URL_CHARS);
  const url = parseUrl(s, "redirectUri");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("redirectUri must be an http(s) URL");
  }
  if (url.pathname !== SSO_CALLBACK_PATH) {
    throw new ValidationError(
      `redirectUri must be this app's callback: <base URL>${SSO_CALLBACK_PATH}`
    );
  }
  return url.toString();
}

function splitList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    return value.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === "string")) {
      throw new ValidationError(`${field} must be a list of strings`);
    }
    return (value as string[]).map((v) => v.trim()).filter(Boolean);
  }
  throw new ValidationError(`${field} must be a list`);
}

function parseDomains(value: unknown): string[] {
  const out = new Set<string>();
  for (const entry of splitList(value, "allowedDomains")) {
    const domain = entry.replace(/^@/, "").toLowerCase();
    if (!isValidDomain(domain)) {
      throw new ValidationError(
        `"${entry.slice(0, 80)}" is not a valid domain name`
      );
    }
    out.add(domain);
  }
  if (out.size > MAX_DOMAINS) {
    throw new ValidationError(`At most ${MAX_DOMAINS} allowed domains`);
  }
  return Array.from(out);
}

function parseEmails(value: unknown): string[] {
  const out = new Set<string>();
  for (const entry of splitList(value, "allowedEmails")) {
    const email = entry.toLowerCase();
    if (!isValidEmail(email)) {
      throw new ValidationError(
        `"${entry.slice(0, 80)}" is not a valid email address`
      );
    }
    out.add(email);
  }
  if (out.size > MAX_EMAILS) {
    throw new ValidationError(`At most ${MAX_EMAILS} allowed emails`);
  }
  return Array.from(out);
}

function parseProvider(value: unknown): SsoProvider {
  if (!SSO_PROVIDERS.includes(value as SsoProvider)) {
    throw new ValidationError(
      `provider must be one of ${SSO_PROVIDERS.join(", ")}`
    );
  }
  return value as SsoProvider;
}

/**
 * Validate a create-or-update request body against the existing config.
 *
 * Every field is optional when a config already exists (the caller may be
 * flipping a single switch such as `enabled`); on first save the provider,
 * issuer, client ID, client secret and redirect URI are all required. A blank
 * client secret means "keep the one on file", mirroring how tenant API keys
 * are edited without ever being sent back to the browser.
 */
export function validateSsoUpdate(
  body: Record<string, unknown>,
  existing: SsoConfig | null
): SsoConfig {
  const present = (key: string) => body[key] !== undefined && body[key] !== null;

  const provider = present("provider")
    ? parseProvider(body.provider)
    : existing?.provider;
  if (!provider) throw new ValidationError("provider is required");
  const preset = SSO_PROVIDER_PRESETS[provider];

  const displayName = present("displayName")
    ? requireString(body.displayName, "displayName", MAX_DISPLAY_NAME_CHARS)
    : existing?.displayName ?? preset.label;

  let issuer = present("issuer") ? validateIssuer(body.issuer) : existing?.issuer;
  if (preset.fixedIssuer) issuer = preset.fixedIssuer;
  if (!issuer) throw new ValidationError("issuer is required");

  const clientId = present("clientId")
    ? requireString(body.clientId, "clientId", MAX_CLIENT_ID_CHARS)
    : existing?.clientId;
  if (!clientId) throw new ValidationError("clientId is required");

  let clientSecret = existing?.clientSecret;
  if (present("clientSecret") && body.clientSecret !== "") {
    clientSecret = requireString(body.clientSecret, "clientSecret", MAX_SECRET_CHARS);
  }
  if (!clientSecret) throw new ValidationError("clientSecret is required");

  const redirectUri = present("redirectUri")
    ? validateRedirectUri(body.redirectUri)
    : existing?.redirectUri;
  if (!redirectUri) throw new ValidationError("redirectUri is required");

  const allowedDomains = present("allowedDomains")
    ? parseDomains(body.allowedDomains)
    : existing?.allowedDomains ?? [];
  const allowedEmails = present("allowedEmails")
    ? parseEmails(body.allowedEmails)
    : existing?.allowedEmails ?? [];
  const allowAnyIdpUser = present("allowAnyIdpUser")
    ? requireBoolean(body.allowAnyIdpUser, "allowAnyIdpUser")
    : existing?.allowAnyIdpUser ?? false;
  const passwordLoginEnabled = present("passwordLoginEnabled")
    ? requireBoolean(body.passwordLoginEnabled, "passwordLoginEnabled")
    : existing?.passwordLoginEnabled ?? true;
  const enabled = present("enabled")
    ? requireBoolean(body.enabled, "enabled")
    : existing?.enabled ?? false;

  if (allowAnyIdpUser && provider === "google") {
    throw new ValidationError(
      "Google sign-in must be restricted to specific domains or emails — otherwise any Google account could sign in"
    );
  }
  if (!allowAnyIdpUser && allowedDomains.length === 0 && allowedEmails.length === 0) {
    throw new ValidationError(
      "Add at least one allowed domain or email address, or allow any account from the provider"
    );
  }

  const now = new Date().toISOString();
  // A test result only vouches for the exact client AND access policy it was
  // run against: an allowlist edit can turn a passing test into a lockout.
  const sameList = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  const coreChanged =
    !existing ||
    existing.issuer !== issuer ||
    existing.clientId !== clientId ||
    existing.clientSecret !== clientSecret ||
    existing.redirectUri !== redirectUri ||
    existing.allowAnyIdpUser !== allowAnyIdpUser ||
    !sameList(existing.allowedDomains, allowedDomains) ||
    !sameList(existing.allowedEmails, allowedEmails);
  const lastTest = coreChanged ? undefined : existing?.lastTest;

  // Turning single sign-on on with the password form off is the one change
  // that can lock every admin out, so the server — not just the wizard —
  // demands a passing test of this exact configuration first. Only the
  // transition is gated: a config that is already live without the fallback
  // can still be edited (its admins signed in through the provider).
  const wasSsoOnly = !!existing && existing.enabled && !existing.passwordLoginEnabled;
  if (enabled && !passwordLoginEnabled && !wasSsoOnly && !lastTest?.ok) {
    throw new ValidationError(
      "Password sign-in is off in this configuration, so a passing test sign-in of the saved configuration is required before it can be enabled. Save, run \"Test sign-in\", then enable."
    );
  }

  return {
    version: 1,
    enabled,
    provider,
    displayName,
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    allowedDomains,
    allowedEmails,
    allowAnyIdpUser,
    passwordLoginEnabled,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastTest,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Validate and persist a create-or-update; returns the stored config. */
export async function saveSsoConfig(
  body: Record<string, unknown>
): Promise<SsoConfig> {
  return withLock(async () => {
    const existing = readSsoConfig();
    const next = validateSsoUpdate(body, existing);
    await writeStoreAtomic(next);
    return next;
  });
}

/** Remove the configuration. Returns false when there was none. */
export async function deleteSsoConfig(): Promise<boolean> {
  return withLock(async () => {
    if (!existsSync(SSO_CONFIG_PATH)) return false;
    try {
      unlinkSync(SSO_CONFIG_PATH);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw e;
    }
    return true;
  });
}

/** Remember the outcome of a "Test sign-in" run for the status card. */
export async function recordSsoTest(record: SsoTestRecord): Promise<void> {
  await withLock(async () => {
    const existing = readSsoConfig();
    if (!existing) return;
    await writeStoreAtomic({ ...existing, lastTest: record });
  });
}
