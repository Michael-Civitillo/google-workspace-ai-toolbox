"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Building2, PlusCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { TENANT_COLOR_CLASSES, type Tenant, type TenantColor } from "@/lib/tenants.shared";

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

  const load = useCallback(() => {
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((data) => {
        setState({
          tenants: data.tenants ?? [],
          activeTenantId: data.activeTenantId ?? null,
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const activeTenant =
    state.tenants.find((t) => t.id === state.activeTenantId) ?? null;

  async function switchTenant(id: string) {
    if (id === state.activeTenantId || switching) return;
    setSwitching(true);
    setOpen(false);
    try {
      const res = await fetch(`/api/tenants/${id}/activate`, { method: "POST" });
      if (res.ok) {
        setState((prev) => ({ ...prev, activeTenantId: id }));
        router.refresh();
      }
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
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      >
        <PlusCircle className="h-3.5 w-3.5 shrink-0" />
        <span>Add a tenant</span>
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
          "w-full flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors text-left",
          colorClasses.bg,
          colorClasses.text,
          colorClasses.border,
          "hover:opacity-90"
        )}
      >
        <span
          className={cn("h-2 w-2 rounded-full shrink-0", colorClasses.dot)}
        />
        <span className="flex-1 text-xs font-medium truncate">
          {activeTenant?.name ?? "No tenant selected"}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div role="menu" className="absolute left-0 right-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-md overflow-hidden">
          <div className="p-1 space-y-0.5">
            {state.tenants.map((tenant) => {
              const tc = TENANT_COLOR_CLASSES[tenant.color as TenantColor];
              const isActive = tenant.id === state.activeTenantId;
              return (
                <button
                  key={tenant.id}
                  onClick={() => switchTenant(tenant.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors text-left",
                    isActive
                      ? cn(tc.bg, tc.text, "font-semibold")
                      : "text-foreground hover:bg-muted"
                  )}
                >
                  <span
                    className={cn("h-2 w-2 rounded-full shrink-0", tc.dot)}
                  />
                  <span className="flex-1 truncate">{tenant.name}</span>
                  {isActive && (
                    <span className="text-[10px] opacity-60">active</span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="border-t border-border p-1">
            <button
              onClick={() => {
                setOpen(false);
                router.push("/tenants");
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <Building2 className="h-3.5 w-3.5" />
              Manage tenants
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
