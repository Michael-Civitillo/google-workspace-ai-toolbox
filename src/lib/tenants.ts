import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

// Re-export shared types/constants so server-side imports still work
export {
  TENANT_COLORS,
  TENANT_COLOR_CLASSES,
  type TenantColor,
  type Tenant,
} from "./tenants.shared";

import type { Tenant } from "./tenants.shared";

interface TenantStore {
  activeTenantId: string | null;
  tenants: Tenant[];
}

const STORE_PATH = path.join(process.cwd(), "tenants.json");

function readStore(): TenantStore {
  if (!existsSync(STORE_PATH)) {
    return { activeTenantId: null, tenants: [] };
  }
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return { activeTenantId: null, tenants: [] };
  }
}

function writeStore(store: TenantStore): void {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function getTenants(): Tenant[] {
  return readStore().tenants;
}

export function getActiveTenantId(): string | null {
  return readStore().activeTenantId;
}

export function getActiveTenant(): Tenant | null {
  const store = readStore();
  if (!store.activeTenantId) return null;
  return store.tenants.find((t) => t.id === store.activeTenantId) ?? null;
}

export function setActiveTenant(id: string): void {
  const store = readStore();
  const tenant = store.tenants.find((t) => t.id === id);
  if (!tenant) throw new Error(`Tenant "${id}" not found`);
  store.activeTenantId = id;
  writeStore(store);
}

export function addTenant(tenant: Omit<Tenant, "id">): Tenant {
  const store = readStore();
  const id =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const newTenant: Tenant = { ...tenant, id };
  store.tenants.push(newTenant);
  // Auto-activate if this is the first tenant
  if (store.tenants.length === 1) {
    store.activeTenantId = id;
  }
  writeStore(store);
  return newTenant;
}

export function updateTenant(
  id: string,
  updates: Partial<Omit<Tenant, "id">>
): Tenant {
  const store = readStore();
  const idx = store.tenants.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`Tenant "${id}" not found`);
  store.tenants[idx] = { ...store.tenants[idx], ...updates };
  writeStore(store);
  return store.tenants[idx];
}

export function deleteTenant(id: string): void {
  const store = readStore();
  const idx = store.tenants.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`Tenant "${id}" not found`);
  store.tenants.splice(idx, 1);
  // If the deleted tenant was active, switch to the first remaining one
  if (store.activeTenantId === id) {
    store.activeTenantId = store.tenants[0]?.id ?? null;
  }
  writeStore(store);
}
