import path from "path";
import {
  readJsonObjectFile,
  writeJsonFileAtomic,
  withFileLock,
} from "./json-store";
import {
  DEFAULT_OIDC_SCOPES,
  DEFAULT_SSO_BUTTON_LABEL,
  type AppConfig,
  type OidcSettings,
  type PublicOidcSettings,
} from "./app-config-types";

/**
 * Application-level configuration store (app-config.json): SSO settings and
 * onboarding state. Lives next to tenants.json, written with the same
 * atomic tmp-file + fsync + rename machinery, and gitignored — the OIDC
 * client secret stays on the host.
 */

const STORE_PATH = path.join(process.cwd(), "app-config.json");

function emptyConfig(): AppConfig {
  return { version: 1, onboardingCompletedAt: null, sso: null };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
}

/**
 * Coerce whatever is on disk into a well-formed AppConfig. Unknown fields are
 * dropped, missing ones defaulted — a hand-edited or older-version file can
 * degrade a setting to its default but can never crash the auth path.
 */
function normalize(parsed: Record<string, unknown> | null): AppConfig {
  if (parsed === null) return emptyConfig();

  const config = emptyConfig();
  if (typeof parsed.onboardingCompletedAt === "string") {
    config.onboardingCompletedAt = parsed.onboardingCompletedAt;
  }

  const sso = parsed.sso;
  if (sso && typeof sso === "object" && !Array.isArray(sso)) {
    const s = sso as Record<string, unknown>;
    const issuer = asString(s.issuer).trim();
    const clientId = asString(s.clientId).trim();
    // An sso block without the two load-bearing fields is unusable — treat it
    // as absent rather than carrying a half-config that can only error later.
    if (issuer && clientId) {
      const settings: OidcSettings = {
        enabled: s.enabled === true,
        issuer,
        clientId,
        clientSecret: asString(s.clientSecret) || undefined,
        scopes: asString(s.scopes).trim() || DEFAULT_OIDC_SCOPES,
        buttonLabel: asString(s.buttonLabel).trim() || DEFAULT_SSO_BUTTON_LABEL,
        baseUrl: asString(s.baseUrl).trim() || undefined,
        allowedDomains: asStringArray(s.allowedDomains).map((d) =>
          d.toLowerCase()
        ),
        allowedEmails: asStringArray(s.allowedEmails).map((e) =>
          e.toLowerCase()
        ),
        passwordLoginEnabled: s.passwordLoginEnabled !== false,
      };
      config.sso = settings;
    }
  }
  return config;
}

export function getAppConfig(): AppConfig {
  return normalize(readJsonObjectFile(STORE_PATH));
}

/**
 * Read-modify-write under the store's lock. The mutator receives the current
 * config and returns the config to persist (mutating in place is fine).
 */
export async function updateAppConfig(
  mutate: (config: AppConfig) => AppConfig | void
): Promise<AppConfig> {
  return withFileLock(STORE_PATH, async () => {
    const config = normalize(readJsonObjectFile(STORE_PATH));
    const next = mutate(config) ?? config;
    await writeJsonFileAtomic(STORE_PATH, next);
    return next;
  });
}

export async function setSsoSettings(
  sso: OidcSettings | null
): Promise<AppConfig> {
  return updateAppConfig((config) => {
    config.sso = sso;
  });
}

export async function setOnboardingCompleted(
  completed: boolean
): Promise<AppConfig> {
  return updateAppConfig((config) => {
    config.onboardingCompletedAt = completed ? new Date().toISOString() : null;
  });
}

/** Strip the client secret before SSO settings cross to the browser. */
export function toPublicSso(sso: OidcSettings): PublicOidcSettings {
  const { clientSecret, ...rest } = sso;
  return { ...rest, hasClientSecret: Boolean(clientSecret) };
}

/** SSO is usable only when enabled AND the app has a session-signing secret. */
export function ssoEnabled(): boolean {
  const sso = getAppConfig().sso;
  return Boolean(sso?.enabled);
}

/**
 * Whether the APP_PASSWORD login form should be accepted right now.
 *
 * The password gate stays on unless the operator explicitly turned it off in
 * the SSO settings — and even then, SSO_RESCUE=true in the environment forces
 * it back on so a broken IdP config can never lock the operator out.
 */
export function passwordLoginAllowed(): boolean {
  if (!process.env.APP_PASSWORD) return false;
  if (process.env.SSO_RESCUE === "true") return true;
  const sso = getAppConfig().sso;
  if (sso?.enabled && !sso.passwordLoginEnabled) return false;
  return true;
}
