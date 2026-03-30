import { NextRequest, NextResponse } from "next/server";
import {
  getTenants,
  getActiveTenantId,
  addTenant,
  TENANT_COLORS,
  type TenantColor,
} from "@/lib/tenants";

export async function GET() {
  const tenants = getTenants();
  const activeTenantId = getActiveTenantId();
  return NextResponse.json({ tenants, activeTenantId });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, color, credentialsFile, adminEmail, geminiApiKey } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!credentialsFile || typeof credentialsFile !== "string") {
      return NextResponse.json(
        { error: "credentialsFile is required" },
        { status: 400 }
      );
    }
    if (!adminEmail || typeof adminEmail !== "string") {
      return NextResponse.json(
        { error: "adminEmail is required" },
        { status: 400 }
      );
    }
    if (color && !TENANT_COLORS.includes(color as TenantColor)) {
      return NextResponse.json({ error: "invalid color" }, { status: 400 });
    }

    const tenant = addTenant({
      name: name.trim(),
      color: (color as TenantColor) || "blue",
      credentialsFile,
      adminEmail,
      geminiApiKey: geminiApiKey || undefined,
    });

    return NextResponse.json({ tenant }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
