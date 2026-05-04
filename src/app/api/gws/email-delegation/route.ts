import { NextRequest, NextResponse } from "next/server";
import { gws, tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const userParam = request.nextUrl.searchParams.get("user");
    const user = requireEmail(userParam, "user");

    const result = await gws(
      [
        "gmail",
        "users",
        "settings",
        "delegates",
        "list",
        `--userId=${user}`,
      ],
      tenant
    );
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {}
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");
    const delegate = requireEmail(body.delegate, "delegate");
    if (user === delegate) {
      throw new ValidationError("Mailbox owner and delegate must be different users");
    }

    const result = await gws(
      [
        "gmail",
        "users",
        "settings",
        "delegates",
        "create",
        `--userId=${user}`,
        `--delegateEmail=${delegate}`,
      ],
      tenant
    );

    audit({
      action: "email_delegation.add",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user, delegate },
      outcome: result.success ? "success" : "error",
      error: result.error,
    });
    return NextResponse.json(result);
  } catch (e) {
    audit({
      action: "email_delegation.add",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: body,
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e);
  }
}

export async function DELETE(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {}
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");
    const delegate = requireEmail(body.delegate, "delegate");

    const result = await gws(
      [
        "gmail",
        "users",
        "settings",
        "delegates",
        "delete",
        `--userId=${user}`,
        `--delegateEmail=${delegate}`,
      ],
      tenant
    );

    audit({
      action: "email_delegation.remove",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user, delegate },
      outcome: result.success ? "success" : "error",
      error: result.error,
    });
    return NextResponse.json(result);
  } catch (e) {
    audit({
      action: "email_delegation.remove",
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
