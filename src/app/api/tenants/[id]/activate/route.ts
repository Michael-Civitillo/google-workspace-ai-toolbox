import { NextRequest, NextResponse } from "next/server";
import { setActiveTenant } from "@/lib/tenants";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    setActiveTenant(id);
    return NextResponse.json({ success: true, activeTenantId: id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
