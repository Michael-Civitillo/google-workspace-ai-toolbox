import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { resetUserPassword, signOutAllSessions } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { errorResponse } from "@/lib/api-errors";
import { actorFromRequest } from "@/lib/session";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * Give an account a new temporary password.
 *
 * POST /api/admin/user/password-reset  { user, confirm, signOut? }
 *
 * The old password stops working the moment this succeeds, so it takes the
 * typed confirmation the destructive routes do: `confirm` must equal `user`,
 * checked here and not only in the browser.
 *
 * The server chooses the password and returns it once, in this response. It
 * is never written to the audit log and the response is marked no-store. The
 * account must choose its own password at the next sign-in.
 *
 * A new password does not sign anyone out: browsers and phones already signed
 * in stay signed in. `signOut: true` also ends those sessions, for an account
 * that may be in someone else's hands. If that second step fails the password
 * has still been changed, so the response still carries it, with
 * `signedOut: false` and the reason.
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

    if (body.signOut !== undefined && typeof body.signOut !== "boolean") {
      throw new ValidationError("signOut must be true or false");
    }
    const signOut = body.signOut === true;

    const result = await resetUserPassword(tenant, user);

    // From here the password HAS changed. Nothing below may throw past this
    // block, or the operator would be left without the password they need.
    let signedOut: boolean | null = null;
    let signOutError: string | null = null;
    if (signOut) {
      try {
        await signOutAllSessions(tenant, result.primaryEmail);
        signedOut = true;
      } catch (e) {
        signedOut = false;
        signOutError = e instanceof Error ? e.message : String(e);
      }
    }

    audit({
      action: "user.password_reset",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {
        user: result.primaryEmail,
        ...(signOut ? { signedOut, ...(signOutError ? { signOutError } : {}) } : {}),
      },
      outcome: "success",
      actor,
    });
    return NextResponse.json(
      { success: true, data: { ...result, signedOut, signOutError } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    audit({
      action: "user.password_reset",
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
