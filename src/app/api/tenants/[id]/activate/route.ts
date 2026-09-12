import { NextRequest, NextResponse } from "next/server";
import {
  setActiveTenant,
  getTenantById,
  TenantNotFoundError,
} from "@/lib/tenants-server";
import { audit } from "@/lib/audit";
import { actorFromRequest } from "@/lib/session";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await actorFromRequest(req);
  // Hoisted above the try so the error path can name the tenant too. Activating
  // repoints every operation that falls back to the active tenant at another
  // domain and another service-account key, so the log records which one.
  let tenantId: string | null = null;
  let tenant = null;
  try {
    const { id } = await params;
    tenantId = id;
    tenant = getTenantById(id);

    await setActiveTenant(id);
    audit({
      action: "tenant.activate",
      tenantId: id,
      tenantName: tenant?.name ?? null,
      params: {
        id,
        name: tenant?.name ?? null,
        adminEmail: tenant?.adminEmail ?? null,
        credentialsFile: tenant?.credentialsFile ?? null,
      },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ success: true, activeTenantId: id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    audit({
      action: "tenant.activate",
      tenantId,
      tenantName: tenant?.name ?? null,
      params: { id: tenantId },
      outcome: "error",
      error: message,
      actor,
    });
    // A stale client activating a just-deleted tenant is a caller error, not a
    // server fault — answer 404 so the UI can refresh its list instead of
    // treating it as an outage.
    const status = error instanceof TenantNotFoundError ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
