import { NextRequest, NextResponse } from "next/server";
import { getTenants, getActiveTenantId, addTenant } from "@/lib/tenants-server";
import { TENANT_COLORS, type TenantColor } from "@/lib/tenant-types";
import {
  isValidEmail,
  validateCredentialsFilePath,
  ValidationError,
} from "@/lib/validate";

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
    const credPath = validateCredentialsFilePath(credentialsFile);
    if (!isValidEmail(adminEmail)) {
      return NextResponse.json(
        { error: "adminEmail must be a valid email address" },
        { status: 400 }
      );
    }
    if (color && !TENANT_COLORS.includes(color as TenantColor)) {
      return NextResponse.json({ error: "invalid color" }, { status: 400 });
    }
    if (
      geminiApiKey !== undefined &&
      geminiApiKey !== "" &&
      (typeof geminiApiKey !== "string" || geminiApiKey.length > 200)
    ) {
      return NextResponse.json(
        { error: "geminiApiKey must be a string under 200 chars" },
        { status: 400 }
      );
    }

    const tenant = await addTenant({
      name: name.trim(),
      color: (color as TenantColor) || "blue",
      credentialsFile: credPath,
      adminEmail: (adminEmail as string).toLowerCase(),
      geminiApiKey: geminiApiKey || undefined,
    });

    return NextResponse.json({ tenant }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
