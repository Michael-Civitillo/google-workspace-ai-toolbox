"use client";

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
const listeners = new Set<(id: string | null) => void>();

export function setCurrentTenantId(id: string | null) {
  _currentTenantId = id;
  for (const fn of listeners) fn(id);
}

export function getCurrentTenantId(): string | null {
  return _currentTenantId;
}

export function subscribeTenantId(fn: (id: string | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * fetch() wrapper that injects the current tenant id as the x-tenant-id
 * header. Use this for every UI → /api request that mutates or reads tenant
 * data.
 */
export async function tfetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("x-tenant-id") && _currentTenantId) {
    headers.set("x-tenant-id", _currentTenantId);
  }
  return fetch(input, { ...init, headers });
}
