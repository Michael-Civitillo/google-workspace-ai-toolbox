"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Building2, PlusCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { TENANT_COLOR_CLASSES, type Tenant, type TenantColor } from "@/lib/tenants";
import {
  setCurrentTenantState,
  subscribeTenantId,
  subscribeTenantsChanged,
} from "@/lib/tenant-client";

interface TenantSwitcherState {
  tenants: Tenant[];
  activeTenantId: string | null;
}

export function TenantSwitcher() {
  const router = useRouter();
  const [state, setState] = useState<TenantSwitcherState>({
    tenants: [],
    activeTenantId: null,
  });
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/tenants")
      .then(async (r) => {
        // An error response has no tenant list — treating its body as one
        // would blank the switcher AND null the global tenant pin, silently
        // retargeting every later request at the server-side default.
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        const tenants: Tenant[] = data.tenants ?? [];
        const activeId: string | null = data.activeTenantId ?? null;
        setState({ tenants, activeTenantId: activeId });
        setCurrentTenantState(
          activeId,
          activeId ? tenants.find((t) => t.id === activeId) ?? null : null
        );
      })
      .catch(() => {
        // Keep the current list/pin — stale beats wrong-tenant.
      });
  }, []);

  useEffect(() => {
    load();
    // Stay in sync if another component updates the current tenant id.
    const unsubId = subscribeTenantId((id) => {
      setState((prev) => (prev.activeTenantId === id ? prev : { ...prev, activeTenantId: id }));
    });
    // Re-fetch the whole list when tenants are added/deleted/renamed elsewhere.
    // This component lives in the persistent layout and never remounts on
    // client navigation, so without this it would show a stale list.
    const unsubList = subscribeTenantsChanged(load);
    return () => {
      unsubId();
      unsubList();
    };
  }, [load]);

  const activeTenant =
    state.tenants.find((t) => t.id === state.activeTenantId) ?? null;

  async function switchTenant(id: string) {
    if (id === state.activeTenantId || switching) return;
    setSwitching(true);
    setSwitchError(null);
    setOpen(false);
    try {
      const res = await fetch(`/api/tenants/${id}/activate`, { method: "POST" });
      if (res.ok) {
        setState((prev) => ({ ...prev, activeTenantId: id }));
        setCurrentTenantState(
          id,
          state.tenants.find((t) => t.id === id) ?? null
        );
        router.refresh();
      } else {
        // A silent failure is dangerous here: the dropdown already closed, so
        // without feedback the operator assumes the switch happened and fires
        // the next action against the OLD tenant. A 404 also means our list is
        // stale (tenant deleted elsewhere) — reload it.
        setSwitchError("Switch failed — still on the previous tenant");
        load();
      }
    } catch {
      // Without this catch a network failure became an unhandled rejection —
      // no feedback at all.
      setSwitchError("Switch failed — still on the previous tenant");
    } finally {
      setSwitching(false);
    }
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-tenant-switcher]")) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const colorClasses = activeTenant
    ? TENANT_COLOR_CLASSES[activeTenant.color as TenantColor]
    : TENANT_COLOR_CLASSES.slate;

  if (state.tenants.length === 0) {
    return (
      <button
        onClick={() => router.push("/tenants")}
        className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-sidebar-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-sidebar-accent/60 hover:text-foreground"
      >
        <PlusCircle className="size-3.5 shrink-0" />
        <span className="flex-1 truncate">Add a tenant</span>
      </button>
    );
  }

  return (
    <div data-tenant-switcher className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={switching}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Active tenant: ${activeTenant?.name ?? "none"}. Click to switch.`}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg border border-sidebar-border bg-card px-2.5 py-1.5 text-left shadow-xs outline-none transition-colors",
          "hover:border-foreground/20 focus-visible:ring-3 focus-visible:ring-ring/40 aria-expanded:border-foreground/20 disabled:opacity-70"
        )}
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md",
            colorClasses.bg
          )}
        >
          {switching ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <span className={cn("size-2 rounded-full", colorClasses.dot)} />
          )}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[12.5px] font-medium">
            {activeTenant?.name ?? "No tenant selected"}
          </span>
          <span className="block truncate text-[10.5px] text-muted-foreground">
            Active tenant
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {switchError && (
        <p className="mt-1 px-1 text-[10px] leading-snug text-danger">
          {switchError}
        </p>
      )}

      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 left-0 z-50 mt-1.5 overflow-hidden rounded-lg border border-border bg-popover shadow-lg shadow-black/10 dark:shadow-black/40"
        >
          <div className="space-y-0.5 p-1">
            {state.tenants.map((tenant) => {
              const tc = TENANT_COLOR_CLASSES[tenant.color as TenantColor];
              const isActive = tenant.id === state.activeTenantId;
              return (
                <button
                  key={tenant.id}
                  role="menuitem"
                  onClick={() => switchTenant(tenant.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    isActive
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-foreground hover:bg-muted"
                  )}
                >
                  <span className={cn("size-2 shrink-0 rounded-full", tc.dot)} />
                  <span className="flex-1 truncate">{tenant.name}</span>
                  {isActive && <Check className="size-3.5 text-primary" />}
                </button>
              );
            })}
          </div>
          <div className="border-t border-border p-1">
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                router.push("/tenants");
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Building2 className="size-3.5" />
              Manage tenants
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
