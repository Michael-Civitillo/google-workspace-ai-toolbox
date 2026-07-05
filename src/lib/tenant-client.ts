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
  for (const fn of tenantsChangedListeners) fn();
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
