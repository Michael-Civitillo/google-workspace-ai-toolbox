import { NextRequest, NextResponse } from "next/server";
import {
  updateTenant,
  deleteTenant,
  getTenantById,
  toPublicTenant,
  TenantNotFoundError,
} from "@/lib/tenants-server";
import { TENANT_COLORS, type TenantColor } from "@/lib/tenant-types";
import {
  isValidEmail,
  validateCredentialsFilePath,
  ValidationError,
} from "@/lib/validate";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";
import { audit, boundedParams } from "@/lib/audit";
import { actorFromRequest } from "@/lib/session";

// Tenant config bodies are tiny — cap aggressively.
const MAX_BODY_BYTES = 16 * 1024;

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await actorFromRequest(req);
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  // Hoisted above the try so the error path can still say which tenant was
  // being edited and what its credentials pointed at before the attempt.
  let tenantId: string | null = null;
  let previous = null;
  try {
    const { id } = await params;
    tenantId = id;
    const { name, color, credentialsFile, adminEmail, geminiApiKey } = body;

    // Validate on "present" (!== undefined), not on truthiness — otherwise a
    // null/""/false slips past the check yet is still written below, corrupting
    // the stored tenant (e.g. TENANT_COLOR_CLASSES[null] is undefined and the
    // UI crashes rendering it).
    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return NextResponse.json(
        { error: "name must be a non-empty string" },
        { status: 400 }
      );
    }
    if (color !== undefined && !TENANT_COLORS.includes(color as TenantColor)) {
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

    // Read the stored tenant before the write: an edit that repoints adminEmail
    // or the key file is only reconstructable from the log if it also records
    // the values the tenant moved away from.
    previous = getTenantById(id);

    const tenant = await updateTenant(id, updates as Parameters<typeof updateTenant>[1]);
    audit({
      action: "tenant.update",
      tenantId: tenant.id,
      tenantName: tenant.name,
      params: {
        id: tenant.id,
        name: tenant.name,
        previousAdminEmail: previous?.adminEmail ?? null,
        adminEmail: tenant.adminEmail,
        previousCredentialsFile: previous?.credentialsFile ?? null,
        credentialsFile: tenant.credentialsFile,
      },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ tenant: toPublicTenant(tenant) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    audit({
      action: "tenant.update",
      tenantId,
      tenantName: previous?.name ?? null,
      // Hand-picked identifiers rather than the whole body: the payload also
      // carries a Gemini API key, which must never reach the log even though
      // audit() redacts that key name.
      params: boundedParams({
        id: tenantId,
        name: body.name,
        adminEmail: body.adminEmail,
        credentialsFile: body.credentialsFile,
      }),
      outcome: "error",
      error: message,
      actor,
    });
    // TenantNotFoundError is a ValidationError subclass — check it first so an
    // unknown id stays a 404.
    const status =
      error instanceof TenantNotFoundError
        ? 404
        : error instanceof ValidationError
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await actorFromRequest(req);
  let tenantId: string | null = null;
  let tenant = null;
  try {
    const { id } = await params;
    tenantId = id;
    // Snapshot the tenant before it goes: once deleteTenant returns there is
    // nothing left to name in the audit entry.
    tenant = getTenantById(id);

    await deleteTenant(id);
    audit({
      action: "tenant.delete",
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
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    audit({
      action: "tenant.delete",
      tenantId,
      tenantName: tenant?.name ?? null,
      params: { id: tenantId },
      outcome: "error",
      error: message,
      actor,
    });
    const status = error instanceof TenantNotFoundError ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
