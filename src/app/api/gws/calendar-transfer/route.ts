import { NextRequest, NextResponse } from "next/server";
import { gws, tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const user = requireEmail(
      request.nextUrl.searchParams.get("user"),
      "user"
    );
    const result = await gws(
      ["calendar", "calendarList", "list", `--calendarId=${user}`],
      tenant
    );
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Transfer calendar ownership.
 *
 * Two distinct steps, the second of which is OPT-IN. The previous version of
 * this route always tried to remove the source user's access after granting
 * the new owner — which silently revoked the source user from secondary
 * calendars (where Google does allow the deletion). That's an irreversible
 * action that should never run by default.
 *
 * Now: only grant ownership unless `removeSourceAccess: true` is supplied
 * AND the additional confirmation flag matches the calendarId — i.e. the
 * caller has typed the calendar they intend to remove access from.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {}
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

    // Step 1: Grant owner access to the target user.
    const grantResult = await gws(
      [
        "calendar",
        "acl",
        "insert",
        `--calendarId=${calendarId}`,
        `--role=owner`,
        `--scope.type=user`,
        `--scope.value=${targetUser}`,
      ],
      tenant
    );

    if (!grantResult.success) {
      audit({
        action: "calendar_transfer.grant",
        tenantId: tenant?.id ?? null,
        tenantName: tenant?.name ?? null,
        params: { sourceUser, targetUser, calendarId },
        outcome: "error",
        error: grantResult.error,
      });
      return NextResponse.json({
        success: false,
        error: `Failed to grant ownership: ${grantResult.error}`,
        step: "grant_ownership",
      });
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
          granted: grantResult.data,
          removed: null,
          note: `Ownership granted to ${targetUser}. Source user's access was NOT removed.`,
        },
      });
    }

    // Step 2 (opt-in only): Remove the source user's access.
    const removeResult = await gws(
      [
        "calendar",
        "acl",
        "delete",
        `--calendarId=${calendarId}`,
        `--ruleId=user:${sourceUser}`,
      ],
      tenant
    );

    audit({
      action: "calendar_transfer.remove_source",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { sourceUser, calendarId },
      outcome: removeResult.success ? "success" : "error",
      error: removeResult.error,
    });

    return NextResponse.json({
      success: true,
      data: {
        granted: grantResult.data,
        removed: removeResult.success ? removeResult.data : null,
        note: removeResult.success
          ? `Ownership granted to ${targetUser} and source user's access removed.`
          : `Ownership granted, but source user's access was NOT removed (Google rejected the deletion — primary calendars cannot have their owner removed). Source user still has access.`,
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
