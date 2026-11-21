import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { deleteForwardingFilter, disableAutoForwarding } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { errorResponse } from "@/lib/api-errors";
import { actorFromRequest } from "@/lib/session";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * Security Check fix: stop a mailbox sending mail outside the organisation.
 *
 * POST /api/admin/security-check/forwarding
 *   { user, kind: "auto-forward", target, confirm }
 *   { user, kind: "filter", filterId, target, confirm }
 *
 * Turns off the mailbox-wide forwarding setting, or deletes the one filter
 * that forwards. Either changes how someone's mail is delivered, so it takes
 * the typed confirmation the other destructive routes do: `confirm` must equal
 * `user`, checked here and not only in the browser.
 *
 * `target` is the address the operator saw in the scan. The mailbox is read
 * again before anything is written, and if it no longer forwards there the
 * request is refused (409) rather than changing something nobody confirmed.
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
  let action = "security_check.forwarding";
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");
    const kind = body.kind;
    if (kind !== "auto-forward" && kind !== "filter") {
      throw new ValidationError('kind must be "auto-forward" or "filter"');
    }
    action =
      kind === "filter"
        ? "security_check.forwarding_filter_delete"
        : "security_check.forwarding_off";
    const target = typeof body.target === "string" ? body.target.trim() : "";
    if (!target || target.length > 320) {
      throw new ValidationError("target must be the address the mail is forwarded to");
    }
    const confirm =
      typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
    if (confirm !== user) {
      throw new ValidationError(
        "Type the mailbox's email address into the confirm field to proceed."
      );
    }

    let changed: boolean;
    if (kind === "filter") {
      const filterId = typeof body.filterId === "string" ? body.filterId : "";
      if (!filterId) throw new ValidationError("filterId is required for a filter");
      changed = (await deleteForwardingFilter(tenant, user, filterId, target)).changed;
    } else {
      changed = (await disableAutoForwarding(tenant, user, target)).changed;
    }

    audit({
      action,
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user, target, changed },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ success: true, data: { changed } });
  } catch (e) {
    audit({
      action,
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
