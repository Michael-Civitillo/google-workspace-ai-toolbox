import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
} from "fs";
import path from "path";
import type { Tenant } from "./tenant-types";

interface TenantStore {
  activeTenantId: string | null;
  tenants: Tenant[];
}

const STORE_PATH = path.join(process.cwd(), "tenants.json");
const STORE_TMP_PATH = path.join(process.cwd(), "tenants.json.tmp");

/**
 * Single-process write mutex. All read-modify-write sequences serialise
 * through this so concurrent API requests can't lose each other's changes.
 */
let writeLock: Promise<unknown> = Promise.resolve();

function readStore(): TenantStore {
  if (!existsSync(STORE_PATH)) {
    return { activeTenantId: null, tenants: [] };
  }
  try {
    const raw = readFileSync(STORE_PATH, "utf-8");
    if (!raw.trim()) return { activeTenantId: null, tenants: [] };
    const parsed = JSON.parse(raw);
    return {
      activeTenantId: parsed.activeTenantId ?? null,
      tenants: Array.isArray(parsed.tenants) ? parsed.tenants : [],
    };
  } catch {
    return { activeTenantId: null, tenants: [] };
  }
}

function writeStoreAtomic(store: TenantStore): void {
  // Write to temp file then rename — guarantees we never leave a half-written
  // tenants.json on disk if the process is killed mid-write.
  writeFileSync(STORE_TMP_PATH, JSON.stringify(store, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });

  // On Windows the rename can transiently fail with EPERM/EBUSY if
  // antivirus / Windows Search Indexer briefly holds the destination
  // file open. Retry a couple of times with tiny backoffs before giving up.
  const MAX_ATTEMPTS = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      renameSync(STORE_TMP_PATH, STORE_PATH);
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      const transient =
        code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt === MAX_ATTEMPTS) break;
      // Tiny synchronous backoff. We're inside withLock() so this only
      // blocks one request at a time, never the event loop forever.
      const until = Date.now() + 25 * attempt;
      while (Date.now() < until) {
        // busy-wait — short enough not to matter, can't await inside sync write
      }
    }
  }
  try {
    if (existsSync(STORE_TMP_PATH)) unlinkSync(STORE_TMP_PATH);
  } catch {}
  throw lastError;
}

async function withLock<T>(fn: () => T): Promise<T> {
  const previous = writeLock;
  let release: () => void = () => {};
  writeLock = new Promise<void>((res) => {
    release = res;
  });
  try {
    await previous;
    return fn();
  } finally {
    release();
  }
}

export function getTenants(): Tenant[] {
  return readStore().tenants;
}

export function getTenantById(id: string): Tenant | null {
  return readStore().tenants.find((t) => t.id === id) ?? null;
}

export function getActiveTenantId(): string | null {
  return readStore().activeTenantId;
}

/**
 * @deprecated Prefer resolveTenant(tenantId). The "active" tenant is global
 * server state and is unsafe when more than one admin (or one admin in two
 * tabs) uses the app at once. Kept only for the bootstrap fallback.
 */
export function getActiveTenant(): Tenant | null {
  const store = readStore();
  if (!store.activeTenantId) return null;
  return store.tenants.find((t) => t.id === store.activeTenantId) ?? null;
}

/**
 * Resolve the tenant to use for a request.
 * Prefers an explicit tenantId from the caller. Falls back to the persisted
 * active tenant only when no ID is supplied. Throws if a tenantId is supplied
 * but doesn't exist — that means a tenant was deleted or the client is stale,
 * and we must NOT silently run against whatever happens to be active.
 */
export function resolveTenant(tenantId: string | null | undefined): Tenant | null {
  if (tenantId) {
    const t = getTenantById(tenantId);
    if (!t) {
      throw new Error(
        `Tenant "${tenantId}" not found. It may have been deleted — refresh the page and pick a tenant.`
      );
    }
    return t;
  }
  return getActiveTenant();
}

export async function setActiveTenant(id: string): Promise<void> {
  await withLock(() => {
    const store = readStore();
    const tenant = store.tenants.find((t) => t.id === id);
    if (!tenant) throw new Error(`Tenant "${id}" not found`);
    store.activeTenantId = id;
    writeStoreAtomic(store);
  });
}

export async function addTenant(tenant: Omit<Tenant, "id">): Promise<Tenant> {
  return withLock(() => {
    const store = readStore();
    const id =
      Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const newTenant: Tenant = { ...tenant, id };
    store.tenants.push(newTenant);
    if (store.tenants.length === 1) {
      store.activeTenantId = id;
    }
    writeStoreAtomic(store);
    return newTenant;
  });
}

export async function updateTenant(
  id: string,
  updates: Partial<Omit<Tenant, "id">>
): Promise<Tenant> {
  return withLock(() => {
    const store = readStore();
    const idx = store.tenants.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`Tenant "${id}" not found`);
    store.tenants[idx] = { ...store.tenants[idx], ...updates };
    writeStoreAtomic(store);
    return store.tenants[idx];
  });
}

export async function deleteTenant(id: string): Promise<void> {
  await withLock(() => {
    const store = readStore();
    const idx = store.tenants.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`Tenant "${id}" not found`);
    store.tenants.splice(idx, 1);
    if (store.activeTenantId === id) {
      store.activeTenantId = store.tenants[0]?.id ?? null;
    }
    writeStoreAtomic(store);
  });
}
