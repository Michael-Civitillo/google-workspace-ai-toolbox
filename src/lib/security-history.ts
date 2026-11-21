import { dataPath } from "./data-dir";
import { readJsonObjectFile, withFileLock, writeJsonFileAtomic } from "./json-store";
import { parseSnapshot, type ScanSnapshot } from "./security-check";

/**
 * The last finished Security Check per tenant, kept so the next scan can say
 * what is new.
 *
 * Only the previous scan is kept, not a history: the question the page answers
 * is "what changed since I last looked", and one baseline answers it. Each
 * snapshot is a list of short finding keys (see security-check.ts), which is
 * all a comparison needs.
 *
 * Lives beside tenants.json in the data directory, written through the shared
 * atomic store. Local to this install: it is not part of a configuration
 * export, and losing it costs one scan's worth of "new" markers.
 */

/** Computed per call, so the data directory can be chosen at start-up. */
export function historyPath(): string {
  return dataPath("security-check-history.json");
}

function tenantKey(tenantId: string | null | undefined): string {
  return tenantId || "default";
}

function readAll(): Record<string, unknown> {
  const raw = readJsonObjectFile(historyPath());
  const tenants = raw?.tenants;
  return tenants && typeof tenants === "object" && !Array.isArray(tenants)
    ? (tenants as Record<string, unknown>)
    : {};
}

/** The previous finished scan for this tenant, or null if there isn't one. */
export function readLastScan(tenantId: string | null | undefined): ScanSnapshot | null {
  return parseSnapshot(readAll()[tenantKey(tenantId)]);
}

/** Replace this tenant's remembered scan. Other tenants' are left alone. */
export async function saveLastScan(
  tenantId: string | null | undefined,
  snapshot: ScanSnapshot
): Promise<void> {
  const file = historyPath();
  await withFileLock(file, async () => {
    const tenants = readAll();
    tenants[tenantKey(tenantId)] = snapshot;
    await writeJsonFileAtomic(file, { version: 1, tenants });
  });
}
