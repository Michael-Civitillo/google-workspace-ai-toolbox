import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import {
  buildGmailClient,
  withGoogleRetry,
  getUser,
  GMAIL_DELEGATION_SCOPES,
} from "@/lib/admin-sdk";
import { recordDelegationSightings } from "@/lib/delegation-sightings";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { errorResponse } from "@/lib/api-errors";
import { actorFromRequest } from "@/lib/session";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

// Delegation bodies are tiny (two emails) — cap aggressively so a malicious
// caller can't stream a huge payload that then gets echoed into audit.log.
const MAX_BODY_BYTES = 16 * 1024;

function tooLarge() {
  return NextResponse.json(
    { success: false, error: "Body too large" },
    { status: 413 }
  );
}

/**
 * Google will not mint an impersonation token for a suspended account, and
 * Gmail rejects a suspended delegate, but neither failure says so: the
 * operator gets an opaque auth error. After a failure, look the parties up
 * and, when one is suspended, answer with the real reason plus a machine
 * code so the dialog can offer to re-enable the account. Runs only on the
 * failure path, so the happy path pays no extra Directory call. Any lookup
 * error here is swallowed: the original failure is the one to report.
 */
type SuspensionCode = "owner_suspended" | "delegate_suspended";

async function diagnoseSuspension(
  tenant: ReturnType<typeof tenantFromRequest>,
  parties: Array<{ role: "owner" | "delegate"; email: string | null }>
): Promise<{ code: SuspensionCode; suspendedUser: string; error: string } | null> {
  for (const p of parties) {
    if (!p.email) continue;
    try {
      const u = await getUser(tenant, p.email);
      if (!u.suspended) continue;
      const suspendedUser = (u.primaryEmail || p.email).toLowerCase();
      return p.role === "owner"
        ? {
            code: "owner_suspended",
            suspendedUser,
            error: `${suspendedUser} is suspended. Google will not read or change a suspended mailbox's settings, so re-enable the account first.`,
          }
        : {
            code: "delegate_suspended",
            suspendedUser,
            error: `${suspendedUser} is suspended, and Gmail only accepts active accounts as delegates. Re-enable the account first.`,
          };
    } catch {
      // Fall through to the original error.
    }
  }
  return null;
}

async function suspensionResponse(
  tenant: ReturnType<typeof tenantFromRequest>,
  parties: Array<{ role: "owner" | "delegate"; email: string | null }>
): Promise<NextResponse | null> {
  const diag = await diagnoseSuspension(tenant, parties);
  if (!diag) return null;
  return NextResponse.json(
    {
      success: false,
      error: diag.error,
      code: diag.code,
      suspendedUser: diag.suspendedUser,
    },
    { status: 409 }
  );
}

export async function GET(request: NextRequest) {
  let tenant = null;
  let user: string | null = null;
  try {
    tenant = tenantFromRequest(request);
    user = requireEmail(request.nextUrl.searchParams.get("user"), "user");
    const owner = user;
    const gmail = buildGmailClient(tenant, owner, [...GMAIL_DELEGATION_SCOPES]);
    // Gmail throttles per user; back off on 429 / rate-limit 403s instead of
    // failing the whole request on the first one. Reads also retry 5xx blips.
    const res = await withGoogleRetry(
      () => gmail.users.settings.delegates.list({ userId: "me" }),
      { retryServerErrors: true }
    );
    // Remember when each delegation was first seen, so the reverse lookup
    // (/delegation-lookup) can later say how long it has at least existed.
    await recordDelegationSightings(
      tenant?.id ?? null,
      (res.data.delegates || [])
        .filter((d) => !!d.delegateEmail)
        .map((d) => ({ owner, delegate: d.delegateEmail as string }))
    );
    return NextResponse.json({ success: true, data: res.data });
  } catch (e) {
    return (
      (await suspensionResponse(tenant, [{ role: "owner", email: user }])) ??
      errorResponse(e)
    );
  }
}

export async function POST(request: NextRequest) {
  const actor = await actorFromRequest(request);
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) return tooLarge();
  let tenant = null;
  let user: string | null = null;
  let delegate: string | null = null;
  try {
    tenant = tenantFromRequest(request, body);
    user = requireEmail(body.user, "user");
    delegate = requireEmail(body.delegate, "delegate");
    if (user === delegate) {
      throw new ValidationError("Mailbox owner and delegate must be different users");
    }

    const gmail = buildGmailClient(tenant, user, [...GMAIL_DELEGATION_SCOPES]);
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
    const suspended = await suspensionResponse(tenant, [
      { role: "owner", email: user },
      { role: "delegate", email: delegate },
    ]);
    audit({
      action: "email_delegation.add",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: boundedParams(body),
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
      actor,
    });
    return suspended ?? errorResponse(e);
  }
}

export async function DELETE(request: NextRequest) {
  const actor = await actorFromRequest(request);
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) return tooLarge();
  let tenant = null;
  let user: string | null = null;
  try {
    tenant = tenantFromRequest(request, body);
    user = requireEmail(body.user, "user");
    const delegate = requireEmail(body.delegate, "delegate");

    const gmail = buildGmailClient(tenant, user, [...GMAIL_DELEGATION_SCOPES]);
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
    // Removing a delegate only impersonates the owner; a suspended delegate
    // can still be removed, so only the owner is diagnosed.
    const suspended = await suspensionResponse(tenant, [
      { role: "owner", email: user },
    ]);
    audit({
      action: "email_delegation.remove",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: boundedParams(body),
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
      actor,
    });
    return suspended ?? errorResponse(e);
  }
}
