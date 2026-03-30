import { NextRequest, NextResponse } from "next/server";
import {
  updateTenant,
  deleteTenant,
  TENANT_COLORS,
  type TenantColor,
} from "@/lib/tenants";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { name, color, credentialsFile, adminEmail, geminiApiKey } = body;

    if (color && !TENANT_COLORS.includes(color as TenantColor)) {
      return NextResponse.json({ error: "invalid color" }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = String(name).trim();
    if (color !== undefined) updates.color = color;
    if (credentialsFile !== undefined) updates.credentialsFile = String(credentialsFile);
    if (adminEmail !== undefined) updates.adminEmail = String(adminEmail);
    if (geminiApiKey !== undefined)
      updates.geminiApiKey = geminiApiKey || undefined;

    const tenant = updateTenant(id, updates as Parameters<typeof updateTenant>[1]);
    return NextResponse.json({ tenant });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    deleteTenant(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
