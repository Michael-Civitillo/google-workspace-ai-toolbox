import { NextRequest, NextResponse } from "next/server";
import { updateTenant, deleteTenant, toPublicTenant } from "@/lib/tenants-server";
import { TENANT_COLORS, type TenantColor } from "@/lib/tenant-types";
import {
  isValidEmail,
  validateCredentialsFilePath,
  ValidationError,
} from "@/lib/validate";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

// Tenant config bodies are tiny — cap aggressively.
const MAX_BODY_BYTES = 16 * 1024;

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  try {
    const { id } = await params;
    const { name, color, credentialsFile, adminEmail, geminiApiKey } = body;

    if (color && !TENANT_COLORS.includes(color as TenantColor)) {
      return NextResponse.json({ error: "invalid color" }, { status: 400 });
    }
    if (adminEmail !== undefined && !isValidEmail(adminEmail)) {
      return NextResponse.json(
        { error: "adminEmail must be a valid email address" },
        { status: 400 }
      );
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

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = String(name).trim();
    if (color !== undefined) updates.color = color;
    if (credentialsFile !== undefined) {
      updates.credentialsFile = validateCredentialsFilePath(credentialsFile);
    }
    if (adminEmail !== undefined)
      updates.adminEmail = (adminEmail as string).toLowerCase();
    if (geminiApiKey !== undefined)
      updates.geminiApiKey = geminiApiKey || undefined;

    const tenant = await updateTenant(id, updates as Parameters<typeof updateTenant>[1]);
    return NextResponse.json({ tenant: toPublicTenant(tenant) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteTenant(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
