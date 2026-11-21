import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { revokeAppForUser } from "@/lib/admin-sdk";
import { REVOKE_APP_BATCH } from "@/lib/security-check";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { errorResponse } from "@/lib/api-errors";
import { actorFromRequest } from "@/lib/session";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * Security Check fix: take away an app's access to people's accounts.
 *
 * POST /api/admin/security-check/revoke-app  { clientId, users: [...], confirm }
 *
 * Revokes the access one app (by client id) holds for each listed account, up
 * to REVOKE_APP_BATCH per request; the page sends longer lists in batches.
 * One account failing does not stop the rest: each gets its own result.
 *
 * Confirmation, checked here and not only in the browser: for a single
 * account `confirm` must be that account's address; for several it must be
 * the word REVOKE, the same rule the bulk un-share uses.
 *
 * This removes the access the app holds today. People can connect it again
 * unless the app is blocked in the Admin console.
 */
const MAX_BODY_BYTES = 64 * 1024;

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
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!clientId) throw new ValidationError("clientId is required");
    if (!Array.isArray(body.users) || body.users.length === 0) {
      throw new ValidationError("users must list at least one account");
    }
    if (body.users.length > REVOKE_APP_BATCH) {
      throw new ValidationError(
        `At most ${REVOKE_APP_BATCH} accounts per request; send the rest in further requests.`
      );
    }
    const users = [
      ...new Set(body.users.map((u: unknown) => requireEmail(u, "users[]"))),
    ] as string[];

    const confirm = typeof body.confirm === "string" ? body.confirm.trim() : "";
    // `batchOf` is how many accounts the operator is revoking in total across
    // the batches of one confirmed action; the rule follows that, so a list of
    // 26 can't be confirmed as "one account" by splitting it.
    const batchOf =
      typeof body.batchOf === "number" && Number.isInteger(body.batchOf)
        ? body.batchOf
        : users.length;
    const single = users.length === 1 && batchOf === 1;
    if (single ? confirm.toLowerCase() !== users[0] : confirm !== "REVOKE") {
      throw new ValidationError(
        single
          ? "Type the account's email address into the confirm field to proceed."
          : "Type REVOKE into the confirm field to revoke the app for several accounts at once."
      );
    }

    const results: Array<{ user: string; changed: boolean; error?: string }> = [];
    for (const user of users) {
      try {
        const { changed } = await revokeAppForUser(tenant, user, clientId);
        results.push({ user, changed });
      } catch (e) {
        results.push({
          user,
          changed: false,
          error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
        });
      }
    }
    const failed = results.filter((r) => r.error).length;

    audit({
      action: "security_check.app_revoke",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {
        clientId,
        users,
        revoked: results.filter((r) => r.changed).length,
        failed,
      },
      outcome: failed === results.length ? "error" : "success",
      error: failed > 0 ? `${failed} of ${results.length} accounts failed` : undefined,
      actor,
    });
    return NextResponse.json({ success: true, data: { results } });
  } catch (e) {
    audit({
      action: "security_check.app_revoke",
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
