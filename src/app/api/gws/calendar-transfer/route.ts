import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { buildCalendarClient, isExternalTarget } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";
import { constantTimeStringEqual } from "@/lib/auth";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const user = requireEmail(request.nextUrl.searchParams.get("user"), "user");

    const cal = buildCalendarClient(tenant, user);
    const res = await cal.calendarList.list();
    return NextResponse.json({ success: true, data: res.data });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Transfer calendar ownership.
 *
 * Two distinct steps, the second of which is OPT-IN. Only grant ownership
 * unless `removeSourceAccess: true` is supplied AND removeConfirmation matches
 * the calendarId — i.e. the caller has typed the calendar they intend to
 * remove access from.
 */
// Transfer bodies are tiny (a couple of emails + a calendar id) — cap
// aggressively so a malicious caller can't stream a huge payload that then
// gets echoed into audit.log.
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: NextRequest) {
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const sourceUser = requireEmail(body.sourceUser, "sourceUser");
    const targetUser = requireEmail(body.targetUser, "targetUser");
    if (sourceUser === targetUser) {
      throw new ValidationError("sourceUser and targetUser must be different");
    }
    const calendarId = body.calendarId
      ? String(body.calendarId).trim()
      : sourceUser;
    if (!calendarId) {
      throw new ValidationError("calendarId is required");
    }

    const removeSourceAccess = body.removeSourceAccess === true;
    const removeConfirmation =
      typeof body.removeConfirmation === "string"
        ? body.removeConfirmation.trim()
        : "";

    if (removeSourceAccess && removeConfirmation !== calendarId) {
      throw new ValidationError(
        "To remove the source user's access you must type the calendarId in the confirmation field"
      );
    }

    // Granting calendar OWNER to an address outside the tenant's verified
    // domains hands calendar control to an outsider — mirror the email-transfer
    // guard and require an explicit typed confirmation for external targets.
    const isExternal = await isExternalTarget(tenant, targetUser);
    if (isExternal) {
      const confirm =
        typeof body.confirmExternal === "string"
          ? body.confirmExternal.trim().toLowerCase()
          : "";
      if (!constantTimeStringEqual(confirm, targetUser)) {
        throw new ValidationError(
          `Target "${targetUser}" is outside this tenant's verified domains. Set confirmExternal to the exact target email to grant it calendar ownership.`
        );
      }
    }

    // Step 1: Grant owner access to the target user.
    const cal = buildCalendarClient(tenant, sourceUser);
    let grantData: unknown;
    try {
      const res = await cal.acl.insert({
        calendarId,
        requestBody: { role: "owner", scope: { type: "user", value: targetUser } },
      });
      grantData = res.data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit({
        action: "calendar_transfer.grant",
        tenantId: tenant?.id ?? null,
        tenantName: tenant?.name ?? null,
        params: { sourceUser, targetUser, calendarId },
        outcome: "error",
        error: msg,
      });
      return NextResponse.json(
        {
          success: false,
          error: `Failed to grant ownership: ${msg}`,
          step: "grant_ownership",
        },
        // Upstream (Google) failure, not a bad request — status matches body.
        { status: 502 }
      );
    }

    audit({
      action: "calendar_transfer.grant",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { sourceUser, targetUser, calendarId },
      outcome: "success",
    });

    if (!removeSourceAccess) {
      return NextResponse.json({
        success: true,
        data: {
          granted: grantData,
          removed: null,
          note: `Ownership granted to ${targetUser}. Source user's access was NOT removed.`,
        },
      });
    }

    // Step 2 (opt-in only): Remove the source user's access.
    let removeError: string | undefined;
    try {
      await cal.acl.delete({ calendarId, ruleId: `user:${sourceUser}` });
    } catch (e) {
      removeError = e instanceof Error ? e.message : String(e);
    }

    audit({
      action: "calendar_transfer.remove_source",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { sourceUser, calendarId },
      outcome: removeError ? "error" : "success",
      error: removeError,
    });

    return NextResponse.json({
      success: true,
      data: {
        granted: grantData,
        removed: removeError ? null : true,
        note: removeError
          ? `Ownership granted, but source user's access was NOT removed (Google rejected the deletion — primary calendars cannot have their owner removed). Source user still has access.`
          : `Ownership granted to ${targetUser} and source user's access removed.`,
      },
    });
  } catch (e) {
    audit({
      action: "calendar_transfer",
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
