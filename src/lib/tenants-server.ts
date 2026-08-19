import path from "path";
import type { Tenant, PublicTenant } from "./tenant-types";
import {
  readJsonObjectFile,
  writeJsonFileAtomic,
  withFileLock,
} from "./json-store";

/**
 * Strip the server-only Gemini API key before a tenant crosses to the browser,
 * exposing only whether one is set. Use for every API response that returns
 * tenant objects.
 */
export function toPublicTenant(tenant: Tenant): PublicTenant {
  const { geminiApiKey, hasGeminiApiKey: _ignored, ...rest } = tenant;
  void _ignored;
  return { ...rest, hasGeminiApiKey: Boolean(geminiApiKey) };
}

interface TenantStore {
  activeTenantId: string | null;
  tenants: Tenant[];
}

const STORE_PATH = path.join(process.cwd(), "tenants.json");

function readStore(): TenantStore {
  // Corruption-safe read: missing/empty/corrupt files come back as null (the
  // unusable ones quarantined first), transient read errors throw so a
  // read-modify-write under the lock aborts instead of persisting an empty
  // store over the real config. See json-store.ts.
  const parsed = readJsonObjectFile(STORE_PATH);
  if (parsed === null) {
    return { activeTenantId: null, tenants: [] };
  }
  return {
    activeTenantId: (parsed.activeTenantId as string | null) ?? null,
    tenants: Array.isArray(parsed.tenants) ? (parsed.tenants as Tenant[]) : [],
  };
}

async function writeStoreAtomic(store: TenantStore): Promise<void> {
  await writeJsonFileAtomic(STORE_PATH, store);
}

function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(STORE_PATH, fn);
}

/** Thrown when a caller names a tenant id that doesn't exist — routes map it to 404. */
export class TenantNotFoundError extends Error {
  constructor(id: string) {
    super(`Tenant "${id}" not found`);
    this.name = "TenantNotFoundError";
  }
}

export function getTenants(): Tenant[] {
  return readStore().tenants;
}

/**
 * One consistent view of the store for callers that need both the list and the
 * active id. Two separate getters would read the file twice, and a concurrent
 * write between the reads could pair a fresh list with a stale active id (or
 * vice versa).
 */
export function getTenantStoreSnapshot(): {
  tenants: Tenant[];
  activeTenantId: string | null;
} {
  const store = readStore();
  return { tenants: store.tenants, activeTenantId: store.activeTenantId };
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
  await withLock(async () => {
    const store = readStore();
    const tenant = store.tenants.find((t) => t.id === id);
    if (!tenant) throw new TenantNotFoundError(id);
    store.activeTenantId = id;
    await writeStoreAtomic(store);
  });
}

export async function addTenant(tenant: Omit<Tenant, "id">): Promise<Tenant> {
  return withLock(async () => {
    const store = readStore();
    const id =
      Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const newTenant: Tenant = { ...tenant, id };
    store.tenants.push(newTenant);
    if (store.tenants.length === 1) {
      store.activeTenantId = id;
    }
    await writeStoreAtomic(store);
    return newTenant;
  });
}

export async function updateTenant(
  id: string,
  updates: Partial<Omit<Tenant, "id">>
): Promise<Tenant> {
  return withLock(async () => {
    const store = readStore();
    const idx = store.tenants.findIndex((t) => t.id === id);
    if (idx === -1) throw new TenantNotFoundError(id);
    store.tenants[idx] = { ...store.tenants[idx], ...updates };
    await writeStoreAtomic(store);
    return store.tenants[idx];
  });
}

export async function deleteTenant(id: string): Promise<void> {
  await withLock(async () => {
    const store = readStore();
    const idx = store.tenants.findIndex((t) => t.id === id);
    if (idx === -1) throw new TenantNotFoundError(id);
    store.tenants.splice(idx, 1);
    if (store.activeTenantId === id) {
      store.activeTenantId = store.tenants[0]?.id ?? null;
    }
    await writeStoreAtomic(store);
  });
}

/**
 * Replace the entire tenant store in one atomic write. Used by configuration
 * import, where the bundle is the source of truth. Callers are responsible
 * for validating every tenant first; this only guarantees the active id
 * actually refers to a tenant in the new list.
 */
export async function replaceTenantStore(
  tenants: Tenant[],
  activeTenantId: string | null
): Promise<void> {
  await withLock(async () => {
    const active =
      activeTenantId && tenants.some((t) => t.id === activeTenantId)
        ? activeTenantId
        : tenants[0]?.id ?? null;
    await writeStoreAtomic({ activeTenantId: active, tenants });
  });
}
