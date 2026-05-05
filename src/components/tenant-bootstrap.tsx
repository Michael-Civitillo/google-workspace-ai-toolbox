"use client";

import { useEffect } from "react";
import { setCurrentTenant, setCurrentTenantId } from "@/lib/tenant-client";
import type { Tenant } from "@/lib/tenant-types";

/**
 * On mount, ask the server for the currently active tenant and seed the
 * client-side tenant id and full tenant object. After this every `tfetch()`
 * call will include the selected tenant id as a header, and confirmation
 * dialogs can show "running against <tenant>".
 *
 * Also re-syncs whenever the page becomes visible again, in case the active
 * tenant changed in another tab.
 */
export function TenantBootstrap() {
  useEffect(() => {
    let cancelled = false;
    async function sync() {
      try {
        const r = await fetch("/api/tenants");
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        const id: string | null = data.activeTenantId ?? null;
        const tenants: Tenant[] = Array.isArray(data.tenants) ? data.tenants : [];
        setCurrentTenantId(id);
        setCurrentTenant(id ? tenants.find((t) => t.id === id) ?? null : null);
      } catch {}
    }
    sync();
    function onVisible() {
      if (document.visibilityState === "visible") sync();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
