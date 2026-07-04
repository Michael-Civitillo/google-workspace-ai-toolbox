import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import {
  addGroupMember,
  GROUP_MEMBER_ROLES,
  listGroupMembers,
  removeGroupMember,
  type GroupMemberRole,
} from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

const MAX_BODY_BYTES = 16 * 1024;

function tooLarge() {
  return NextResponse.json(
    { success: false, error: "Body too large" },
    { status: 413 }
  );
}

/** List the direct members of a group. */
export async function GET(request: NextRequest) {
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
        params: body,
        outcome: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      return NextResponse.json(
        {
          success: false,
          error: e instanceof Error ? e.message : "Failed to add group member",
        },
        { status: 502 }
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
      params: body,
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e);
  }
}

/** Remove a member from a group. */
export async function DELETE(request: NextRequest) {
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) return tooLarge();
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const group = requireEmail(body.group, "group");
    const member = requireEmail(body.member, "member");

    let result: { removed: boolean };
    try {
      result = await removeGroupMember(tenant, group, member);
    } catch (e) {
      audit({
        action: "groups.member_remove",
        tenantId: tenant?.id ?? null,
        tenantName: tenant?.name ?? null,
        params: body,
        outcome: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      return NextResponse.json(
        {
          success: false,
          error:
            e instanceof Error ? e.message : "Failed to remove group member",
        },
        { status: 502 }
      );
    }

    audit({
      action: "groups.member_remove",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { group, member, removed: result.removed },
      outcome: "success",
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
