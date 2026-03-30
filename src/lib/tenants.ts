import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

export const TENANT_COLORS = [
  "emerald",
  "blue",
  "amber",
  "rose",
  "violet",
  "slate",
] as const;

export type TenantColor = (typeof TENANT_COLORS)[number];

export interface Tenant {
  id: string;
  name: string;
  color: TenantColor;
  credentialsFile: string;
  adminEmail: string;
  geminiApiKey?: string;
}

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

/** Color classes used to visually distinguish tenants */
export const TENANT_COLOR_CLASSES: Record<
  TenantColor,
  { bg: string; text: string; border: string; dot: string }
> = {
  emerald: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
    dot: "bg-emerald-500",
  },
  blue: {
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
    dot: "bg-blue-500",
  },
  amber: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    dot: "bg-amber-500",
  },
  rose: {
    bg: "bg-rose-50",
    text: "text-rose-700",
    border: "border-rose-200",
    dot: "bg-rose-500",
  },
  violet: {
    bg: "bg-violet-50",
    text: "text-violet-700",
    border: "border-violet-200",
    dot: "bg-violet-500",
  },
  slate: {
    bg: "bg-slate-100",
    text: "text-slate-700",
    border: "border-slate-300",
    dot: "bg-slate-500",
  },
};
