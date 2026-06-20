import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { buildGmailClient } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";

const GMAIL_DELEGATION_SCOPES = [
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

// Delegation bodies are tiny (two emails) — cap aggressively so a malicious
// caller can't stream a huge payload that then gets echoed into audit.log.
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Read the request body as JSON, rejecting anything over MAX_BODY_BYTES.
 * Returns null when the body is too large so the caller can return a 413.
 */
async function readBody(
  request: NextRequest
): Promise<Record<string, unknown> | null> {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) return null;
  let raw = "";
  try {
    raw = await request.text();
  } catch {}
  if (raw.length > MAX_BODY_BYTES) return null;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function tooLarge() {
  return NextResponse.json(
    { success: false, error: "Body too large" },
    { status: 413 }
  );
}

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const user = requireEmail(request.nextUrl.searchParams.get("user"), "user");
    const gmail = buildGmailClient(tenant, user, GMAIL_DELEGATION_SCOPES);
    const res = await gmail.users.settings.delegates.list({ userId: "me" });
    return NextResponse.json({ success: true, data: res.data });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: NextRequest) {
  const body = await readBody(request);
  if (body === null) return tooLarge();
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");
    const delegate = requireEmail(body.delegate, "delegate");
    if (user === delegate) {
      throw new ValidationError("Mailbox owner and delegate must be different users");
    }

    const gmail = buildGmailClient(tenant, user, GMAIL_DELEGATION_SCOPES);
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
  const body = await readBody(request);
  if (body === null) return tooLarge();
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");
    const delegate = requireEmail(body.delegate, "delegate");

    const gmail = buildGmailClient(tenant, user, GMAIL_DELEGATION_SCOPES);
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
