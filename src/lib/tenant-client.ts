"use client";

import { useSyncExternalStore } from "react";
import type { Tenant } from "./tenant-types";

/**
 * Client-side helper for tracking the *currently selected* tenant in the UI
 * and ensuring every API request the UI makes includes a tenantId.
 *
 * The server uses this to make sure the action runs against the tenant the
 * user is looking at — not "whatever happens to be active in tenants.json
 * right now", which can change between page-load and button-click if the user
 * has another tab open or another admin switches tenants.
 */

let _currentTenantId: string | null = null;
let _currentTenant: Tenant | null = null;
let _generation = 0;
const listeners = new Set<(id: string | null) => void>();
const tenantsChangedListeners = new Set<() => void>();

/**
 * Monotonic counter bumped on every tenant-state write. Async flows snapshot
 * it before a fetch and compare after: if it moved, someone (the switcher, a
 * bootstrap in another effect) changed tenants mid-flight and the fetched
 * snapshot is stale — applying it would silently revert the newer selection.
 */
export function tenantStateGeneration(): number {
  return _generation;
}

function notify() {
  for (const fn of listeners) fn(_currentTenantId);
}

/**
 * Set the current tenant id and full object together, then notify subscribers.
 *
 * Setting BOTH before notifying is deliberate: `useCurrentTenant`'s subscriber
 * reads `_currentTenant` at notify time, so updating the id first and the object
 * second (two separate setters) made the hook briefly return the NEW id paired
 * with the OLD/`null` tenant — which surfaced the wrong "Running against …"
 * tenant in confirmation dialogs. Always go through this setter.
 */
export function setCurrentTenantState(
  id: string | null,
  tenant: Tenant | null
) {
  _currentTenantId = id;
  _currentTenant = tenant;
  _generation++;
  notify();
}

export function subscribeTenantId(fn: (id: string | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Broadcast that the set of tenants (not just the active one) changed — added,
 * deleted, or renamed. The sidebar switcher lives in the persistent layout and
 * never remounts on client navigation, so it subscribes to this to re-fetch its
 * list instead of showing stale names until a full reload.
 */
export function notifyTenantsChanged() {
  // A list fetched before the change is out of date: the next load starts afresh.
  _listInflight = null;
  for (const fn of tenantsChangedListeners) fn();
}

// ---------------------------------------------------------------------------
// The tenant list, fetched once for every part of the page that needs it
// ---------------------------------------------------------------------------

export type TenantListStatus = "loading" | "loaded" | "error";

interface TenantListSnapshot {
  tenants: Tenant[];
  status: TenantListStatus;
}

let _list: TenantListSnapshot = { tenants: [], status: "loading" };
let _listInflight: Promise<void> | null = null;
const listListeners = new Set<() => void>();
const SERVER_LIST: TenantListSnapshot = { tenants: [], status: "loading" };

function setList(next: TenantListSnapshot) {
  _list = next;
  for (const fn of listListeners) fn();
}

/**
 * Fetch the tenant list. Callers at the same moment share one request (the
 * sidebar, the bootstrap and a page used to make three). When the server's
 * answer arrives it also sets the active tenant, unless the operator switched
 * while it was on its way: an answer from before a switch must not undo it.
 * A failed request keeps the last good list.
 */
export function loadTenantList(): Promise<void> {
  if (_listInflight) return _listInflight;
  const request: Promise<void> = fetchTenantList(_generation).finally(() => {
    if (_listInflight === request) _listInflight = null;
  });
  _listInflight = request;
  return request;
}

async function fetchTenantList(genBefore: number): Promise<void> {
  try {
    const r = await fetch("/api/tenants", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const tenants: Tenant[] = Array.isArray(data?.tenants) ? data.tenants : [];
    const activeId: string | null =
      typeof data?.activeTenantId === "string" ? data.activeTenantId : null;
    setList({ tenants, status: "loaded" });
    if (_generation === genBefore) {
      const next = activeId ? tenants.find((t) => t.id === activeId) ?? null : null;
      // Only when something changed (or on the first load, which is what
      // marks the state as known): a write bumps the generation, which other
      // flows read as "the tenant moved under me".
      const changed =
        _generation === 0 ||
        activeId !== _currentTenantId ||
        (next ? !sameTenantDetails(next, _currentTenant) : _currentTenant !== null);
      if (changed) setCurrentTenantState(activeId, next);
    } else if (_currentTenantId) {
      // Keep the operator's pick, with its latest details (a rename).
      const mine = tenants.find((t) => t.id === _currentTenantId);
      if (mine && !sameTenantDetails(mine, _currentTenant)) setCurrentTenantState(mine.id, mine);
    }
  } catch {
    // Stale beats wrong-tenant: keep what was there.
    setList({ tenants: _list.tenants, status: _list.status === "loaded" ? "loaded" : "error" });
  }
}

function sameTenantDetails(a: Tenant, b: Tenant | null): boolean {
  return (
    !!b &&
    a.id === b.id &&
    a.name === b.name &&
    a.color === b.color &&
    a.adminEmail === b.adminEmail &&
    a.credentialsFile === b.credentialsFile
  );
}

/** Whether the tenant list has loaded, for code outside components. */
export function tenantListStatus(): TenantListStatus {
  return _list.status;
}

/** The tenant list and whether it has loaded, for components. */
export function useTenantList(): TenantListSnapshot {
  return useSyncExternalStore(
    (fn) => {
      listListeners.add(fn);
      return () => {
        listListeners.delete(fn);
      };
    },
    () => _list,
    () => SERVER_LIST
  );
}

/**
 * Why a multi-step run may not start pinned to `tenantId`, or null when it
 * may. A null pin sends no tenant at all, and the server then uses whichever
 * tenant is active in its own settings, which, while the list is still
 * loading, need not be the one the page is about to show. Once the list has
 * loaded empty, null is right: the install runs on environment credentials.
 */
export function tenantPinProblem(tenantId: string | null): string | null {
  if (tenantId) return null;
  if (_list.status !== "loaded") {
    // And ask for it, so "in a moment" is true.
    void loadTenantList();
    return "The tenant list is still loading — try again in a moment.";
  }
  return _list.tenants.length === 0
    ? null
    : "No tenant is selected — pick one in the sidebar first.";
}

export function subscribeTenantsChanged(fn: () => void): () => void {
  tenantsChangedListeners.add(fn);
  return () => {
    tenantsChangedListeners.delete(fn);
  };
}

/**
 * fetch() wrapper that injects the current tenant id as the x-tenant-id
 * header — UNLESS the caller has already set a tenant id explicitly.
 *
 * Pass `tenantIdOverride` when running multi-step flows (e.g. bulk operations)
 * to pin every request to the tenant that was active at the start, so a tab
 * switch mid-flow can't redirect later requests to a different tenant.
 */
export async function tfetch(
  input: string,
  init: RequestInit = {},
  tenantIdOverride?: string | null
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("x-tenant-id")) {
    const id = tenantIdOverride ?? _currentTenantId;
    if (id) headers.set("x-tenant-id", id);
  }
  return fetch(input, { ...init, headers });
}

function subscribeStore(onStoreChange: () => void): () => void {
  return subscribeTenantId(() => onStoreChange());
}

/**
 * React hook returning the currently selected tenant. Updates whenever the
 * tenant switcher changes, so dialogs can show "running against X" live.
 *
 * Built on useSyncExternalStore so a tenant change that lands between the
 * initial render and subscription (e.g. the bootstrap fetch resolving during
 * hydration) is picked up when React re-checks the snapshot on subscribe —
 * the old set-state-in-effect version stayed stale until the NEXT change.
 */
export function useCurrentTenant(): { id: string | null; tenant: Tenant | null } {
  const id = useSyncExternalStore(
    subscribeStore,
    () => _currentTenantId,
    () => null
  );
  const tenant = useSyncExternalStore(
    subscribeStore,
    () => _currentTenant,
    () => null
  );
  return { id, tenant };
}
