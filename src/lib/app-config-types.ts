import type { Tenant } from "./tenant-types";

/**
 * Client-safe application-level config types (SSO, onboarding state, and the
 * portable export bundle). Kept separate from the server module
 * (`app-config.ts`) because that module imports `node:fs`, which the Next.js
 * client bundle cannot resolve.
 */

/** Path the OIDC provider must redirect back to, relative to the app origin. */
export const OIDC_CALLBACK_PATH = "/api/auth/sso/callback";

export const DEFAULT_OIDC_SCOPES = "openid email profile";
export const DEFAULT_SSO_BUTTON_LABEL = "Continue with SSO";

export interface OidcSettings {
  enabled: boolean;
  /**
   * Issuer identifier, e.g. https://accounts.google.com or
   * https://login.microsoftonline.com/<tenant>/v2.0. Discovery metadata is
   * fetched from <issuer>/.well-known/openid-configuration.
   */
  issuer: string;
  clientId: string;
  /**
   * Server-only secret. Never serialise this to API responses — use
   * PublicOidcSettings for anything that crosses to the browser. Optional:
   * public clients (PKCE-only) leave it empty.
   */
  clientSecret?: string;
  /** Space-separated scope list. "openid" is always enforced server-side. */
  scopes: string;
  /** Label for the SSO button on the login page, e.g. "Sign in with Okta". */
  buttonLabel: string;
  /**
   * Canonical external origin of this deployment (e.g. https://toolbox.corp.example).
   * The redirect URI registered at the IdP is <baseUrl><OIDC_CALLBACK_PATH>.
   * When unset, the origin of the incoming request is used — fine for direct
   * access, unreliable behind reverse proxies.
   */
  baseUrl?: string;
  /**
   * Who may sign in via SSO. Emails are exact matches, domains match the part
   * after "@". Both empty = anyone the IdP authenticates is allowed in.
   */
  allowedDomains: string[];
  allowedEmails: string[];
  /**
   * Whether APP_PASSWORD login stays available alongside SSO. Only takes
   * effect while SSO is enabled — the password gate is never silently lost.
   */
  passwordLoginEnabled: boolean;
}

/**
 * The shape safe to send to the browser: identical to OidcSettings but with
 * the secret stripped and replaced by a boolean flag.
 */
export type PublicOidcSettings = Omit<OidcSettings, "clientSecret"> & {
  hasClientSecret: boolean;
};

export interface AppConfig {
  version: 1;
  /** ISO timestamp once the first-launch wizard is completed (or skipped). */
  onboardingCompletedAt: string | null;
  sso: OidcSettings | null;
}

/** Marker + version for the portable export bundle. */
export const CONFIG_BUNDLE_KIND = "gws-toolbox-config";
export const CONFIG_BUNDLE_VERSION = 1;

/**
 * Everything needed to stand the toolbox up on another server: app-level
 * settings, the tenant list, and — unless the exporter opts out of secrets —
 * the service-account JSON key files themselves, so a restore needs no
 * side-channel file copying.
 */
export interface ConfigBundle {
  kind: typeof CONFIG_BUNDLE_KIND;
  version: typeof CONFIG_BUNDLE_VERSION;
  exportedAt: string;
  includesSecrets: boolean;
  app: {
    sso: OidcSettings | null;
    onboardingCompletedAt: string | null;
  };
  tenants: {
    activeTenantId: string | null;
    tenants: Tenant[];
  };
  /**
   * Raw content of each tenant's service-account key file, keyed by the path
   * stored in the tenant (as it was on the source server). Import writes
   * these back to disk — at the same path when possible, relocated under the
   * app otherwise. Present only when includesSecrets; absent in bundles from
   * older versions.
   */
  credentialFiles?: Record<string, string>;
}
