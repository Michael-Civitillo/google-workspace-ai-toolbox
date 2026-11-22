import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { tenantFromRequest } from "@/lib/gws";
import { applySignature } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api-errors";
import { actorFromRequest } from "@/lib/session";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * Set one person's email signature from a template.
 *
 * POST /api/admin/signatures  { user, template, confirm }
 *
 * The template is filled in on the server from that person's directory
 * profile; the browser never sends finished HTML, so what lands in a mailbox
 * is always what the template rules produce. Replacing a signature overwrites
 * the one the person has, so `confirm` must equal `user`, checked here and
 * not only in the browser. The response carries the previous signature so a
 * run can be exported and put back by hand.
 */
const MAX_BODY_BYTES = 32 * 1024;

export async function POST(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  const actor = await actorFromRequest(request);
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }
  let tenant = null;
  // The template is free text and can be long; the log records who, not what.
  const auditParams = { user: typeof body.user === "string" ? body.user.slice(0, 320) : null };
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user").toLowerCase();
    if (typeof body.template !== "string") {
      throw new ValidationError("template must be text");
    }
    const confirm =
      typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
    if (confirm !== user) {
      throw new ValidationError(
        "Type the user's email address into the confirm field to proceed."
      );
    }

    const result = await applySignature(tenant, user, body.template);

    audit({
      action: "signatures.apply",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user: result.user, changed: result.changed },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    audit({
      action: "signatures.apply",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: auditParams,
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
      actor,
    });
    return errorResponse(e);
  }
}
