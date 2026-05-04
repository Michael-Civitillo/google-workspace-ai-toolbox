"use client";

import { useEffect } from "react";
import { setCurrentTenantId } from "@/lib/tenant-client";

/**
 * On mount, ask the server for the currently active tenant and seed the
 * client-side tenant id. After this every `tfetch()` call in the app will
 * include the selected tenant id as a header.
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
        if (!cancelled) setCurrentTenantId(data.activeTenantId ?? null);
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
