import { dataPath } from "./data-dir";
import {
  readJsonObjectFile,
  withFileLock,
  writeJsonFileAtomic,
} from "./json-store";

/**
 * First-seen record for mailbox delegations.
 *
 * Google does not say when a delegate was added: the Gmail API returns only
 * the delegate's address and whether they accepted, and the admin audit log
 * does not record delegation changes at all. Open Admin's own audit log
 * covers grants made through Open Admin; for everything else, the best
 * available answer is "it has existed at least since we first noticed it".
 *
 * Every delegate list the app reads — the per-mailbox lookup and the
 * tenant-wide reverse lookup — is recorded here as a sighting keyed by
 * tenant, owner and delegate. The store only ever grows more useful: the
 * earlier a delegation was first observed, the tighter the lower bound.
 *
 * Lives beside tenants.json in the data directory, written through the
 * shared atomic store so a crash mid-write can't corrupt it.
 */

export const SIGHTINGS_PATH = dataPath("delegation-sightings.json");

export interface SightingRecord {
  /** ISO timestamp of the first time this delegation was observed. */
  firstSeen: string;
  /** ISO timestamp of the most recent observation. */
  lastSeen: string;
}

interface SightingsStore {
  version: 1;
  entries: Record<string, SightingRecord>;
}

/**
 * Bound the file so a very large tenant scanned for years cannot grow it
 * without limit. 50k pairs is far beyond any real delegation inventory;
 * past it, the pairs not seen for longest are dropped first.
 */
const MAX_ENTRIES = 50_000;

// lastSeen is bumped at most this often per pair, so a scan that re-reads
// an unchanged tenant does not rewrite the file for every page.
const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000;

function tenantKey(tenantId: string | null | undefined): string {
  return tenantId || "default";
}

function pairKey(
  tenantId: string | null | undefined,
  owner: string,
  delegate: string
): string {
  return `${tenantKey(tenantId)}|${owner.toLowerCase()}|${delegate.toLowerCase()}`;
}

function readStore(): SightingsStore {
  const raw = readJsonObjectFile(SIGHTINGS_PATH);
  const entries: Record<string, SightingRecord> = {};
  if (raw && raw.entries && typeof raw.entries === "object") {
    for (const [k, v] of Object.entries(
      raw.entries as Record<string, unknown>
    )) {
      if (
        v &&
        typeof v === "object" &&
        typeof (v as SightingRecord).firstSeen === "string" &&
        typeof (v as SightingRecord).lastSeen === "string"
      ) {
        entries[k] = {
          firstSeen: (v as SightingRecord).firstSeen,
          lastSeen: (v as SightingRecord).lastSeen,
        };
      }
    }
  }
  return { version: 1, entries };
}

function evictIfOverCap(store: SightingsStore): void {
  const keys = Object.keys(store.entries);
  if (keys.length <= MAX_ENTRIES) return;
  keys.sort(
    (a, b) =>
      Date.parse(store.entries[a].lastSeen) -
      Date.parse(store.entries[b].lastSeen)
  );
  for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) {
    delete store.entries[k];
  }
}

/**
 * Record that these delegations exist right now. New pairs get a firstSeen
 * of `now`; known pairs keep their firstSeen and refresh lastSeen. Never
 * throws: a sighting is a nice-to-have, and the lookup that produced it must
 * still answer.
 */
export async function recordDelegationSightings(
  tenantId: string | null | undefined,
  pairs: ReadonlyArray<{ owner: string; delegate: string }>,
  now: Date = new Date()
): Promise<void> {
  if (pairs.length === 0) return;
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  try {
    await withFileLock(SIGHTINGS_PATH, async () => {
      const store = readStore();
      let changed = false;
      for (const { owner, delegate } of pairs) {
        if (!owner || !delegate) continue;
        const key = pairKey(tenantId, owner, delegate);
        const existing = store.entries[key];
        if (!existing) {
          store.entries[key] = { firstSeen: nowIso, lastSeen: nowIso };
          changed = true;
        } else if (
          nowMs - Date.parse(existing.lastSeen) >= LAST_SEEN_REFRESH_MS ||
          Number.isNaN(Date.parse(existing.lastSeen))
        ) {
          existing.lastSeen = nowIso;
          changed = true;
        }
      }
      if (!changed) return;
      evictIfOverCap(store);
      await writeJsonFileAtomic(SIGHTINGS_PATH, store);
    });
  } catch (e) {
    console.warn(
      "[delegation-sightings] could not record sightings:",
      e instanceof Error ? e.message : e
    );
  }
}

/**
 * Look up the sighting record for each (owner → delegate) pair. Owners with
 * no record are absent from the result.
 */
export function getDelegationSightings(
  tenantId: string | null | undefined,
  delegate: string,
  owners: ReadonlyArray<string>
): Map<string, SightingRecord> {
  const out = new Map<string, SightingRecord>();
  let store: SightingsStore;
  try {
    store = readStore();
  } catch {
    return out;
  }
  for (const owner of owners) {
    const rec = store.entries[pairKey(tenantId, owner, delegate)];
    if (rec) out.set(owner.toLowerCase(), rec);
  }
  return out;
}
