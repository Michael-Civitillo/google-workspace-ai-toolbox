import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import {
  buildCalendarClient,
  isExternalTarget,
  withGoogleRetry,
} from "@/lib/admin-sdk";
import { isValidEmail, requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { constantTimeStringEqual } from "@/lib/auth";
import { errorResponse } from "@/lib/api-errors";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";
import { actorFromRequest } from "@/lib/session";

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const user = requireEmail(request.nextUrl.searchParams.get("user"), "user");

    const cal = buildCalendarClient(tenant, user);
    // Page through the full calendar list: one call returns at most 250
    // entries, so a user subscribed to more calendars would get a silently
    // truncated picker. Bounded so a pathological account can't pin the route.
    const MAX_CALENDARS = 1000;
    // Reads retry rate limits and 5xx blips; a multi-page walk would
    // otherwise fail outright on one throttled page.
    let res = await withGoogleRetry(
      () => cal.calendarList.list({ maxResults: 250 }),
      { retryServerErrors: true }
    );
    const items = [...(res.data.items || [])];
    let pageToken = res.data.nextPageToken ?? undefined;
    while (pageToken && items.length < MAX_CALENDARS) {
      const token = pageToken;
      res = await withGoogleRetry(
        () => cal.calendarList.list({ maxResults: 250, pageToken: token }),
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

// Google's own calendar addresses: a bounded local part (which may contain the
// "#" that bundled calendars use) under one of the *.calendar.google.com hosts.
const GOOGLE_CALENDAR_ID_RE =
  /^[A-Za-z0-9._%+'#-]{1,200}@[A-Za-z0-9.-]{0,60}calendar\.google\.com$/;

export async function POST(request: NextRequest) {
  const actor = await actorFromRequest(request);
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
    // calendarId is interpolated into the acl.insert/acl.delete request path,
    // so bound it to the shapes Google actually issues: the literal "primary",
    // an email-shaped id (a user's own calendar), or one of Google's generated
    // calendar addresses — group, resource and the read-only bundled calendars,
    // whose local parts run longer than an address' 64 characters and can carry
    // a "#" (en.usa#holiday@group.v.calendar.google.com).
    if (
      calendarId !== "primary" &&
      !isValidEmail(calendarId) &&
      !GOOGLE_CALENDAR_ID_RE.test(calendarId)
    ) {
      throw new ValidationError(
        'calendarId must be "primary" or a calendar address such as user@example.com or <id>@group.calendar.google.com'
      );
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
      // Rate-limit retries only: never re-send a write after a 5xx that may
      // have committed.
      const res = await withGoogleRetry(
        () =>
          cal.acl.insert({
            calendarId,
            requestBody: {
              role: "owner",
              scope: { type: "user", value: targetUser },
            },
          }),
        { retryServerErrors: false }
      );
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
        actor,
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
      actor,
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
      await withGoogleRetry(
        () => cal.acl.delete({ calendarId, ruleId: `user:${sourceUser}` }),
        { retryServerErrors: false }
      );
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
      actor,
    });

    return NextResponse.json({
      success: true,
      data: {
        granted: grantData,
        removed: removeError ? null : true,
        // Surface Google's actual rejection: the old hardcoded "primary
        // calendars cannot have their owner removed" explanation was only one
        // of several causes (permissions, stale rule id, transient errors) and
        // made real failures undiagnosable from the UI.
        note: removeError
          ? `Ownership granted, but source user's access was NOT removed — Google rejected the deletion: ${removeError}. Source user still has access.`
          : `Ownership granted to ${targetUser} and source user's access removed.`,
      },
    });
  } catch (e) {
    audit({
      action: "calendar_transfer",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: boundedParams(body),
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
      actor,
    });
    return errorResponse(e);
  }
}
