import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { createUser } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { errorResponse } from "@/lib/api-errors";
import { actorFromRequest } from "@/lib/session";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * Create a user account.
 *
 * POST /api/admin/user/create
 *   { givenName, familyName, primaryEmail, orgUnitPath?, confirm }
 *
 * A new account costs a licence and gives someone a way in, so it takes the
 * typed confirmation the destructive routes do: `confirm` must equal
 * `primaryEmail`, checked here and not only in the browser.
 *
 * The server chooses the temporary password and returns it once, in this
 * response. It is never written to the audit log (the request carries no
 * password to log, and the success entry leaves it out) and the response is
 * marked no-store. The account must choose its own password at first sign-in.
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
    const primaryEmail = requireEmail(body.primaryEmail, "primaryEmail").toLowerCase();
    const text = (value: unknown, field: string) => {
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw new ValidationError(`${field} must be text`);
      }
      return (value as string | undefined) ?? "";
    };
    const givenName = text(body.givenName, "givenName");
    const familyName = text(body.familyName, "familyName");
    const orgUnitPath = text(body.orgUnitPath, "orgUnitPath");
    const confirm =
      typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
    if (confirm !== primaryEmail) {
      throw new ValidationError(
        "Type the new account's email address into the confirm field to proceed."
      );
    }

    const created = await createUser(tenant, {
      givenName,
      familyName,
      primaryEmail,
      orgUnitPath: orgUnitPath || undefined,
    });

    audit({
      action: "user.create",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user: created.primaryEmail, orgUnitPath: created.orgUnitPath },
      outcome: "success",
      actor,
    });
    return NextResponse.json(
      { success: true, data: created },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    audit({
      action: "user.create",
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
