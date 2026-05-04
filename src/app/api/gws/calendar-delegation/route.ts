import { NextRequest, NextResponse } from "next/server";
import { gws, tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";

const ALLOWED_ROLES = new Set(["freeBusyReader", "reader", "writer", "owner"]);

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const calendarId = requireEmail(
      request.nextUrl.searchParams.get("calendarId"),
      "calendarId"
    );

    const result = await gws(
      ["calendar", "acl", "list", `--calendarId=${calendarId}`],
      tenant
    );
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {}
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const calendarId = requireEmail(body.calendarId, "calendarId");
    const delegateEmail = requireEmail(body.delegateEmail, "delegateEmail");
    const role = String(body.role || "");
    if (!ALLOWED_ROLES.has(role)) {
      throw new ValidationError(
        `role must be one of: ${[...ALLOWED_ROLES].join(", ")}`
      );
    }

    const result = await gws(
      [
        "calendar",
        "acl",
        "insert",
        `--calendarId=${calendarId}`,
        `--role=${role}`,
        `--scope.type=user`,
        `--scope.value=${delegateEmail}`,
      ],
      tenant
    );

    audit({
      action: "calendar_delegation.add",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { calendarId, delegateEmail, role },
      outcome: result.success ? "success" : "error",
      error: result.error,
    });
    return NextResponse.json(result);
  } catch (e) {
    audit({
      action: "calendar_delegation.add",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: body,
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e);
  }
}

export async function DELETE(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {}
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const calendarId = requireEmail(body.calendarId, "calendarId");
    const ruleId = String(body.ruleId || "");
    if (!ruleId.trim()) {
      throw new ValidationError("ruleId is required");
    }

    const result = await gws(
      [
        "calendar",
        "acl",
        "delete",
        `--calendarId=${calendarId}`,
        `--ruleId=${ruleId}`,
      ],
      tenant
    );

    audit({
      action: "calendar_delegation.remove",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { calendarId, ruleId },
      outcome: result.success ? "success" : "error",
      error: result.error,
    });
    return NextResponse.json(result);
  } catch (e) {
    audit({
      action: "calendar_delegation.remove",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: body,
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  const message = e instanceof Error ? e.message : "Unexpected error";
  const status = e instanceof ValidationError ? 400 : 500;
  return NextResponse.json({ success: false, error: message }, { status });
}
