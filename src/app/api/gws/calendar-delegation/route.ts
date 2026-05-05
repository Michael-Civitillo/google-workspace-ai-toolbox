import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { buildCalendarClient } from "@/lib/admin-sdk";
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

    const cal = buildCalendarClient(tenant, calendarId);
    const res = await cal.acl.list({ calendarId });
    return NextResponse.json({ success: true, data: res.data });
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

    const cal = buildCalendarClient(tenant, calendarId);
    const res = await cal.acl.insert({
      calendarId,
      requestBody: { role, scope: { type: "user", value: delegateEmail } },
    });

    audit({
      action: "calendar_delegation.add",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { calendarId, delegateEmail, role },
      outcome: "success",
    });
    return NextResponse.json({ success: true, data: res.data });
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

    const cal = buildCalendarClient(tenant, calendarId);
    await cal.acl.delete({ calendarId, ruleId });

    audit({
      action: "calendar_delegation.remove",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { calendarId, ruleId },
      outcome: "success",
    });
    return NextResponse.json({ success: true });
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
