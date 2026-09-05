import type { Tenant } from "./tenant-types";
import type { SsoConfig } from "./sso-types";

/**
 * Client-safe application-level config types: onboarding state and the
 * portable export bundle. Kept separate from the server module
 * (`app-config.ts`) because that module imports `node:fs`, which the Next.js
 * client bundle cannot resolve. Single sign-on settings have their own store
 * and types (`sso-types.ts` / `sso-server.ts`); the bundle just carries them.
 */

export interface AppConfig {
  version: 1;
  /** ISO timestamp once the first-launch wizard is completed (or skipped). */
  onboardingCompletedAt: string | null;
}

/** Marker + version for the portable export bundle. */
export const CONFIG_BUNDLE_KIND = "gws-toolbox-config";
export const CONFIG_BUNDLE_VERSION = 1;

/**
 * The single sign-on configuration as it travels in a bundle: the stored
 * shape, with the client secret optional so a sanitised export can omit it.
 */
export type BundleSsoConfig = Omit<SsoConfig, "clientSecret"> & {
  clientSecret?: string;
};

/**
 * Everything needed to stand the app up on another server: single sign-on
 * settings, onboarding state, the tenant list, and — unless the exporter
 * opts out of secrets — the service-account JSON key files themselves, so a
 * restore needs no side-channel file copying.
 */
export interface ConfigBundle {
  kind: typeof CONFIG_BUNDLE_KIND;
  version: typeof CONFIG_BUNDLE_VERSION;
  exportedAt: string;
  includesSecrets: boolean;
  app: {
    sso: BundleSsoConfig | null;
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
