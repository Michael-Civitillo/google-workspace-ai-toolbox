"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { loadTenantList, tenantListStatus } from "@/lib/tenant-client";

/**
 * Ask the server for the tenant list and the active tenant, and seed the
 * client-side tenant state. After this every `tfetch()` call carries the
 * selected tenant id, and confirmation dialogs can show "running against
 * <tenant>". The request is shared with the sidebar's switcher.
 *
 * Asked again on every page until it has worked: the first ask happens on
 * the sign-in page, before there is a session, and the move to the app after
 * signing in doesn't reload the page. Also re-synced whenever the page
 * becomes visible again, in case the active tenant changed in another tab.
 * An answer from before a switch made in this tab never undoes it (see
 * loadTenantList).
 */
export function TenantBootstrap() {
  const pathname = usePathname();

  useEffect(() => {
    if (tenantListStatus() !== "loaded") void loadTenantList();
  }, [pathname]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") void loadTenantList();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return null;
}
