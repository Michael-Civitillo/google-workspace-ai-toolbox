"use client";

import { useEffect } from "react";
import { loadTenantList } from "@/lib/tenant-client";

/**
 * On mount, ask the server for the tenant list and the active tenant, and
 * seed the client-side tenant state. After this every `tfetch()` call carries
 * the selected tenant id, and confirmation dialogs can show "running against
 * <tenant>". The request is shared with the sidebar's switcher.
 *
 * Also re-syncs whenever the page becomes visible again, in case the active
 * tenant changed in another tab. An answer from before a switch made in this
 * tab never undoes it (see loadTenantList).
 */
export function TenantBootstrap() {
  useEffect(() => {
    void loadTenantList();
    function onVisible() {
      if (document.visibilityState === "visible") void loadTenantList();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return null;
}
