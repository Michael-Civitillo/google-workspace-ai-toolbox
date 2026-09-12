import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import {
  buildCalendarClient,
  isExternalTarget,
  withGoogleRetry,
} from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { actorFromRequest } from "@/lib/session";
import { constantTimeStringEqual } from "@/lib/auth";
import { errorResponse } from "@/lib/api-errors";
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

// Calendar only ever issues ACL rule ids of these shapes, and the id goes
// straight into the upstream acl.delete path — so reject anything else here
// rather than let a caller-supplied string address arbitrary Google resources.
const ACL_RULE_ID_RE = /^(?:user|group|domain):\S+$/;
const MAX_RULE_ID_LENGTH = 254;

function requireRuleId(value: unknown): string {
  const ruleId = typeof value === "string" ? value.trim() : "";
  if (!ruleId) {
    throw new ValidationError("ruleId is required");
  }
  if (
    ruleId.length > MAX_RULE_ID_LENGTH ||
    (ruleId !== "default" && !ACL_RULE_ID_RE.test(ruleId))
  ) {
    throw new ValidationError(
      'ruleId must be "default" or "<user|group|domain>:<value>"'
    );
  }
  return ruleId;
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
    // Reads retry rate limits and 5xx blips; a multi-page walk would
    // otherwise fail outright on one throttled page.
    let res = await withGoogleRetry(
      () => cal.acl.list({ calendarId, maxResults: 250 }),
      { retryServerErrors: true }
    );
    const items = [...(res.data.items || [])];
    let pageToken = res.data.nextPageToken ?? undefined;
    while (pageToken && items.length < MAX_ACL_RULES) {
      const token = pageToken;
      res = await withGoogleRetry(
        () => cal.acl.list({ calendarId, maxResults: 250, pageToken: token }),
        { retryServerErrors: true }
      );
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
  const actor = await actorFromRequest(request);
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
    // Rate-limit retries only: never re-send a write after a 5xx that may have
    // committed.
    const res = await withGoogleRetry(
      () =>
        cal.acl.insert({
          calendarId,
          requestBody: { role, scope: { type: "user", value: delegateEmail } },
        }),
      { retryServerErrors: false }
    );

    audit({
      action: "calendar_delegation.add",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { calendarId, delegateEmail, role },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ success: true, data: res.data });
  } catch (e) {
    audit({
      action: "calendar_delegation.add",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      // Bound the rejected body: an unvalidated payload logged verbatim lets a
      // looping client bloat audit.log and push real entries out of view.
      params: boundedParams(body),
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
      actor,
    });
    return errorResponse(e);
  }
}

export async function DELETE(request: NextRequest) {
  const actor = await actorFromRequest(request);
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) return tooLarge();
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const calendarId = requireEmail(body.calendarId, "calendarId");
    const ruleId = requireRuleId(body.ruleId);

    const cal = buildCalendarClient(tenant, calendarId);
    await withGoogleRetry(() => cal.acl.delete({ calendarId, ruleId }), {
      retryServerErrors: false,
    });

    audit({
      action: "calendar_delegation.remove",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { calendarId, ruleId },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    audit({
      action: "calendar_delegation.remove",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      // Bound the rejected body: an unvalidated payload logged verbatim lets a
      // looping client bloat audit.log and push real entries out of view.
      params: boundedParams(body),
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
      actor,
    });
    return errorResponse(e);
  }
}
