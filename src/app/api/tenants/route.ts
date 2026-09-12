import { NextRequest, NextResponse } from "next/server";
import {
  getTenantStoreSnapshot,
  addTenant,
  toPublicTenant,
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

export async function GET() {
  try {
    // One snapshot read: separate getters would read the store twice, and a
    // concurrent write between them could pair a fresh list with a stale
    // active id.
    const { tenants, activeTenantId } = getTenantStoreSnapshot();
    return NextResponse.json({
      tenants: tenants.map(toPublicTenant),
      activeTenantId,
    });
  } catch (error) {
    // A transient store read failure must come back as JSON — every consumer
    // does res.json() unconditionally and would otherwise choke on the
    // framework's HTML error page.
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const actor = await actorFromRequest(req);
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  try {
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

    // A new tenant points every later Workspace operation at another domain
    // and another service-account key, so the log has to name who added it.
    audit({
      action: "tenant.create",
      tenantId: tenant.id,
      tenantName: tenant.name,
      params: {
        id: tenant.id,
        name: tenant.name,
        adminEmail: tenant.adminEmail,
        credentialsFile: tenant.credentialsFile,
      },
      outcome: "success",
      actor,
    });

    return NextResponse.json({ tenant: toPublicTenant(tenant) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    audit({
      action: "tenant.create",
      tenantId: null,
      tenantName: null,
      // Hand-picked identifiers rather than the whole body: the payload also
      // carries a Gemini API key, which must never reach the log even though
      // audit() redacts that key name.
      params: boundedParams({
        name: body.name,
        adminEmail: body.adminEmail,
        credentialsFile: body.credentialsFile,
      }),
      outcome: "error",
      error: message,
      actor,
    });
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
