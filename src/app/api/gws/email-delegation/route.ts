import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { buildGmailClient, withGoogleRetry } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { errorResponse } from "@/lib/api-errors";
import { actorFromRequest } from "@/lib/session";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

const GMAIL_DELEGATION_SCOPES = [
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

// Delegation bodies are tiny (two emails) — cap aggressively so a malicious
// caller can't stream a huge payload that then gets echoed into audit.log.
const MAX_BODY_BYTES = 16 * 1024;

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
    // Gmail throttles per user; back off on 429 / rate-limit 403s instead of
    // failing the whole request on the first one. Reads also retry 5xx blips.
    const res = await withGoogleRetry(
      () => gmail.users.settings.delegates.list({ userId: "me" }),
      { retryServerErrors: true }
    );
    return NextResponse.json({ success: true, data: res.data });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: NextRequest) {
  const actor = await actorFromRequest(request);
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) return tooLarge();
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");
    const delegate = requireEmail(body.delegate, "delegate");
    if (user === delegate) {
      throw new ValidationError("Mailbox owner and delegate must be different users");
    }

    const gmail = buildGmailClient(tenant, user, GMAIL_DELEGATION_SCOPES);
    // Rate-limit retries only: a create is not idempotent, so a 5xx that may
    // have committed must surface rather than be blindly re-sent.
    await withGoogleRetry(
      () =>
        gmail.users.settings.delegates.create({
          userId: "me",
          requestBody: { delegateEmail: delegate },
        }),
      { retryServerErrors: false }
    );

    audit({
      action: "email_delegation.add",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user, delegate },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    audit({
      action: "email_delegation.add",
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

export async function DELETE(request: NextRequest) {
  const actor = await actorFromRequest(request);
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) return tooLarge();
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");
    const delegate = requireEmail(body.delegate, "delegate");

    const gmail = buildGmailClient(tenant, user, GMAIL_DELEGATION_SCOPES);
    await withGoogleRetry(
      () =>
        gmail.users.settings.delegates.delete({
          userId: "me",
          delegateEmail: delegate,
        }),
      { retryServerErrors: false }
    );

    audit({
      action: "email_delegation.remove",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user, delegate },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    audit({
      action: "email_delegation.remove",
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
