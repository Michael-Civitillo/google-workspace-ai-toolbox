import {
  readJsonObjectFile,
  writeJsonFileAtomic,
  withFileLock,
} from "./json-store";
import { dataPath } from "./data-dir";
import type { AppConfig } from "./app-config-types";

/**
 * Application-level configuration store (app-config.json): today just the
 * onboarding state. Lives next to tenants.json and sso.json, written with the
 * same atomic tmp-file + fsync + rename machinery, and gitignored.
 */

const STORE_PATH = dataPath("app-config.json");

function emptyConfig(): AppConfig {
  return { version: 1, onboardingCompletedAt: null };
}

/**
 * Coerce whatever is on disk into a well-formed AppConfig. Unknown fields are
 * dropped, missing ones defaulted — a hand-edited or older-version file can
 * degrade a setting to its default but can never crash a request.
 */
function normalize(parsed: Record<string, unknown> | null): AppConfig {
  const config = emptyConfig();
  if (parsed && typeof parsed.onboardingCompletedAt === "string") {
    config.onboardingCompletedAt = parsed.onboardingCompletedAt;
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

export async function setOnboardingCompleted(
  completed: boolean
): Promise<AppConfig> {
  return updateAppConfig((config) => {
    config.onboardingCompletedAt = completed ? new Date().toISOString() : null;
  });
}
