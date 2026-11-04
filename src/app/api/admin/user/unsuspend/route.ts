import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { unsuspendUser } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { errorResponse } from "@/lib/api-errors";
import { actorFromRequest } from "@/lib/session";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * Re-enable a suspended account.
 *
 * POST /api/admin/user/unsuspend  { user, confirm }
 *
 * Offered from the delegation dialogs when Google refuses to touch a
 * suspended mailbox. Reactivation lets the person sign in again and resumes
 * everything the suspension stopped, so it takes the same typed confirmation
 * the destructive routes do: `confirm` must equal `user`, checked here and
 * not only in the browser.
 */
const MAX_BODY_BYTES = 16 * 1024;

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
    const user = requireEmail(body.user, "user").toLowerCase();
    const confirm =
      typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
    if (confirm !== user) {
      throw new ValidationError(
        "Type the user's email address into the confirm field to proceed."
      );
    }

    const result = await unsuspendUser(tenant, user);

    audit({
      action: "user.unsuspend",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    audit({
      action: "user.unsuspend",
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
