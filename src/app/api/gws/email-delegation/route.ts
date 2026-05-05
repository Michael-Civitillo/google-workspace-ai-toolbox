import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { readFileSync } from "fs";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";
import type { Tenant } from "@/lib/tenant-types";

const GMAIL_DELEGATION_SCOPES = [
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

function buildGmailClient(tenant: Tenant | null, impersonateEmail: string) {
  const credFile =
    tenant?.credentialsFile ||
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
  if (!credFile) {
    throw new Error(
      "No credentials configured. Add a tenant on the Tenants page or set GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE."
    );
  }
  const creds = JSON.parse(readFileSync(credFile, "utf-8"));
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: GMAIL_DELEGATION_SCOPES,
    subject: impersonateEmail,
  });
  return google.gmail({ version: "v1", auth });
}

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const userParam = request.nextUrl.searchParams.get("user");
    const user = requireEmail(userParam, "user");

    const gmail = buildGmailClient(tenant, user);
    const res = await gmail.users.settings.delegates.list({ userId: "me" });
    return NextResponse.json({ success: true, data: res.data });
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

    const gmail = buildGmailClient(tenant, user);
    await gmail.users.settings.delegates.create({
      userId: "me",
      requestBody: { delegateEmail: delegate },
    });

    audit({
      action: "email_delegation.add",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user, delegate },
      outcome: "success",
    });
    return NextResponse.json({ success: true });
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

    const gmail = buildGmailClient(tenant, user);
    await gmail.users.settings.delegates.delete({
      userId: "me",
      delegateEmail: delegate,
    });

    audit({
      action: "email_delegation.remove",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user, delegate },
      outcome: "success",
    });
    return NextResponse.json({ success: true });
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
