import { NextRequest, NextResponse } from "next/server";
import { setActiveTenant, TenantNotFoundError } from "@/lib/tenants-server";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await setActiveTenant(id);
    return NextResponse.json({ success: true, activeTenantId: id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    // A stale client activating a just-deleted tenant is a caller error, not a
    // server fault — answer 404 so the UI can refresh its list instead of
    // treating it as an outage.
    const status = error instanceof TenantNotFoundError ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
