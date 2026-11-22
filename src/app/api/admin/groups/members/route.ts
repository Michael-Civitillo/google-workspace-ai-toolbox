import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { tenantFromRequest } from "@/lib/gws";
import {
  addGroupMember,
  GROUP_MEMBER_ROLES,
  isExternalTarget,
  listGroupMembers,
  removeGroupMember,
  type GroupMemberRole,
} from "@/lib/admin-sdk";
import { constantTimeStringEqual } from "@/lib/auth";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";
import { actorFromRequest } from "@/lib/session";
import { errorStatusFor } from "@/lib/api-errors";

const MAX_BODY_BYTES = 16 * 1024;

function tooLarge() {
  return NextResponse.json(
    { success: false, error: "Body too large" },
    { status: 413 }
  );
}

/** List the direct members of a group. */
export async function GET(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  try {
    const tenant = tenantFromRequest(request);
    const params = request.nextUrl.searchParams;
    const group = requireEmail(params.get("group"), "group");

    const pageToken = params.get("pageToken") || undefined;
    const pageSizeRaw = params.get("pageSize");
    let pageSize: number | undefined;
    if (pageSizeRaw !== null && pageSizeRaw !== "") {
      const n = Number(pageSizeRaw);
      if (!Number.isInteger(n)) {
        throw new ValidationError("pageSize must be an integer");
      }
      pageSize = Math.min(200, Math.max(1, n));
    }

    const result = await listGroupMembers(tenant, group, {
      pageToken,
      pageSize,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    return errorResponse(e);
  }
}

function parseRole(raw: unknown): GroupMemberRole {
  const role = String(raw || "MEMBER").toUpperCase();
  if (!(GROUP_MEMBER_ROLES as readonly string[]).includes(role)) {
    throw new ValidationError(
      `role must be one of: ${GROUP_MEMBER_ROLES.join(", ")}`
    );
  }
  return role as GroupMemberRole;
}

/** Add a member to a group. */
export async function POST(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  const actor = await actorFromRequest(request);
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) return tooLarge();
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const group = requireEmail(body.group, "group");
    const member = requireEmail(body.member, "member");
    const role = parseRole(body.role);
    // Only enforce the role on an existing membership when the caller chose
    // one explicitly — a defaulted MEMBER must never demote an existing
    // OWNER/MANAGER on re-add.
    const roleExplicit = body.role !== undefined && body.role !== null && body.role !== "";

    // An owner can change the group's settings and membership, and delete it:
    // the page's typed confirmation is checked here too, since this route
    // accepts anything holding a session.
    const typed = (v: unknown) =>
      typeof v === "string" ? v.trim().toLowerCase() : "";
    if (role === "OWNER" && !constantTimeStringEqual(typed(body.confirm), member)) {
      throw new ValidationError(
        `Making ${member} an owner of ${group} lets them change and delete the group. Type their address into the confirm field to proceed.`
      );
    }
    // Someone outside the organisation then receives the group's mail and
    // can see who else is in it: name them a second time, as the email and
    // calendar transfers ask.
    if (
      (await isExternalTarget(tenant, member)) &&
      !constantTimeStringEqual(typed(body.confirmExternal), member)
    ) {
      throw new ValidationError(
        `${member} is outside this tenant's domains. Set confirmExternal to the exact address to add them to ${group}.`
      );
    }

    let result: { alreadyMember: boolean; previousRole?: string; roleChanged?: boolean };
    try {
      result = await addGroupMember(tenant, group, member, role, {
        enforceRole: roleExplicit,
      });
    } catch (e) {
      audit({
        action: "groups.member_add",
        tenantId: tenant?.id ?? null,
        tenantName: tenant?.name ?? null,
        params: boundedParams(body),
        outcome: "error",
        error: e instanceof Error ? e.message : String(e),
        actor,
      });
      return NextResponse.json(
        {
          success: false,
          error: e instanceof Error ? e.message : "Failed to add group member",
        },
        { status: errorStatusFor(e) }
      );
    }

    audit({
      action: "groups.member_add",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {
        group,
        member,
        role,
        alreadyMember: result.alreadyMember,
        ...(result.roleChanged !== undefined
          ? { roleChanged: result.roleChanged, previousRole: result.previousRole }
          : {}),
      },
      outcome: "success",
      actor,
    });
    return NextResponse.json({
      success: true,
      data: {
        group,
        member,
        role,
        alreadyMember: result.alreadyMember,
        ...(result.roleChanged !== undefined
          ? { roleChanged: result.roleChanged, previousRole: result.previousRole }
          : {}),
      },
    });
  } catch (e) {
    audit({
      action: "groups.member_add",
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

/** Remove a member from a group. */
export async function DELETE(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  const actor = await actorFromRequest(request);
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) return tooLarge();
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const group = requireEmail(body.group, "group");
    const member = requireEmail(body.member, "member");

    // The UI gates removal behind a typed confirm dialog, but this endpoint
    // accepts any body carrying a session cookie — so re-confirm the exact
    // member here before silently stripping someone's access.
    const confirm =
      typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
    if (confirm !== member) {
      throw new ValidationError(
        "Type the member's email address into the confirm field to proceed."
      );
    }

    let result: { removed: boolean };
    try {
      result = await removeGroupMember(tenant, group, member);
    } catch (e) {
      audit({
        action: "groups.member_remove",
        tenantId: tenant?.id ?? null,
        tenantName: tenant?.name ?? null,
        params: boundedParams(body),
        outcome: "error",
        error: e instanceof Error ? e.message : String(e),
        actor,
      });
      return NextResponse.json(
        {
          success: false,
          error:
            e instanceof Error ? e.message : "Failed to remove group member",
        },
        { status: errorStatusFor(e) }
      );
    }

    audit({
      action: "groups.member_remove",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { group, member, removed: result.removed },
      outcome: "success",
      actor,
    });
    return NextResponse.json({
      success: true,
      data: {
        group,
        member,
        removed: result.removed,
        ...(result.removed
          ? {}
          : { message: `${member} was not a member of ${group}` }),
      },
    });
  } catch (e) {
    audit({
      action: "groups.member_remove",
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

function errorResponse(e: unknown) {
  const message = e instanceof Error ? e.message : "Unexpected error";
  const status = errorStatusFor(e);
  return NextResponse.json({ success: false, error: message }, { status });
}
