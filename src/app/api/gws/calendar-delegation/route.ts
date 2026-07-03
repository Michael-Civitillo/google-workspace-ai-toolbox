import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { buildCalendarClient, isExternalTarget } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";
import { constantTimeStringEqual } from "@/lib/auth";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

const ALLOWED_ROLES = new Set(["freeBusyReader", "reader", "writer", "owner"]);

// Calendar ACL bodies are tiny — cap aggressively so a malicious caller can't
// stream a huge payload that then gets echoed into audit.log.
const MAX_BODY_BYTES = 16 * 1024;

function tooLarge() {
  return NextResponse.json(
    { success: false, error: "Body too large" },
    { status: 413 }
  );
}

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const calendarId = requireEmail(
      request.nextUrl.searchParams.get("calendarId"),
      "calendarId"
    );

    const cal = buildCalendarClient(tenant, calendarId);
    // Page through the full ACL: one acl.list call returns at most 100 rules,
    // so a widely-shared calendar would render a silently truncated list (and
    // hide exactly the grants an admin is auditing for). Bounded so a
    // pathological calendar can't pin the route.
    const MAX_ACL_RULES = 1000;
    let res = await cal.acl.list({ calendarId, maxResults: 250 });
    const items = [...(res.data.items || [])];
    let pageToken = res.data.nextPageToken ?? undefined;
    while (pageToken && items.length < MAX_ACL_RULES) {
      res = await cal.acl.list({ calendarId, maxResults: 250, pageToken });
      items.push(...(res.data.items || []));
      pageToken = res.data.nextPageToken ?? undefined;
    }
    return NextResponse.json({
      success: true,
      data: { ...res.data, items, nextPageToken: pageToken ?? null },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: NextRequest) {
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) return tooLarge();
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

    // Granting OWNER hands full calendar control (including re-sharing and
    // deletion) to the delegate — for an address outside the tenant's verified
    // domains that's the same exposure as a calendar transfer, so mirror the
    // sibling flows' typed confirmExternal gate. Lower roles stay ungated:
    // sharing free/busy or read access with an external partner is routine.
    if (role === "owner" && (await isExternalTarget(tenant, delegateEmail))) {
      const confirm =
        typeof body.confirmExternal === "string"
          ? body.confirmExternal.trim().toLowerCase()
          : "";
      if (!constantTimeStringEqual(confirm, delegateEmail)) {
        throw new ValidationError(
          `Delegate "${delegateEmail}" is outside this tenant's verified domains. Set confirmExternal to the exact delegate email to grant it calendar ownership.`
        );
      }
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
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) return tooLarge();
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
