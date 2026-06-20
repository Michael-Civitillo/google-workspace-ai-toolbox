import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { buildGmailClient, isAlreadyExistsError } from "@/lib/admin-sdk";
import { listDomains } from "@/lib/admin-sdk";
import { requireEmail, ValidationError, emailDomain } from "@/lib/validate";
import { audit } from "@/lib/audit";
import { constantTimeStringEqual } from "@/lib/auth";

const GMAIL_SETTINGS_SCOPES = [
  "https://www.googleapis.com/auth/gmail.settings.sharing",
];

const ALLOWED_ACTIONS = new Set(["keep", "archive", "trash", "markRead"]);

// Forwarding bodies are tiny — cap aggressively so a malicious caller can't
// stream a huge payload that then gets echoed into audit.log.
const MAX_BODY_BYTES = 16 * 1024;

const DISPOSITION_MAP: Record<string, string> = {
  keep: "leaveInInbox",
  archive: "archive",
  trash: "trash",
  markRead: "markRead",
};

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const user = requireEmail(request.nextUrl.searchParams.get("user"), "user");
    const gmail = buildGmailClient(tenant, user, GMAIL_SETTINGS_SCOPES);
    const res = await gmail.users.labels.list({ userId: "me" });
    return NextResponse.json({ success: true, data: res.data });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Set up email forwarding from source to target user.
 *
 * Auto-forwarding to an external domain is a major data-exfiltration risk.
 * If the target domain is not one of this tenant's verified domains, the
 * caller must explicitly opt in with `confirmExternal: "<target email>"`.
 */
export async function POST(request: NextRequest) {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }
  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch {}
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }
  let body: Record<string, unknown> = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {}
  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const sourceUser = requireEmail(body.sourceUser, "sourceUser");
    const targetUser = requireEmail(body.targetUser, "targetUser");
    if (sourceUser === targetUser) {
      throw new ValidationError("sourceUser and targetUser must be different");
    }
    const action = String(body.action || "keep");
    if (!ALLOWED_ACTIONS.has(action)) {
      throw new ValidationError(
        `action must be one of: ${[...ALLOWED_ACTIONS].join(", ")}`
      );
    }

    // External-domain check.
    let isExternal = false;
    try {
      const domains = await listDomains(tenant);
      const tenantDomains = new Set(
        domains.filter((d) => d.verified).map((d) => d.domainName)
      );
      isExternal = !tenantDomains.has(emailDomain(targetUser));
    } catch (e) {
      // Fail closed: treat as external when we can't enumerate domains.
      isExternal = true;
      console.warn(
        "email-transfer: could not list domains, treating target as external:",
        e
      );
    }

    if (isExternal) {
      const confirm =
        typeof body.confirmExternal === "string"
          ? body.confirmExternal.trim().toLowerCase()
          : "";
      if (!constantTimeStringEqual(confirm, targetUser)) {
        throw new ValidationError(
          `Target "${targetUser}" is outside this tenant's verified domains. Set confirmExternal to the exact target email to proceed.`
        );
      }
    }

    const gmail = buildGmailClient(tenant, sourceUser, GMAIL_SETTINGS_SCOPES);

    // Step 1: Create forwarding address.
    let forwardData: unknown;
    try {
      const res = await gmail.users.settings.forwardingAddresses.create({
        userId: "me",
        requestBody: { forwardingEmail: targetUser },
      });
      forwardData = res.data;
    } catch (e) {
      // A duplicate means a previous attempt already registered the address —
      // continue to enabling auto-forwarding so a retry isn't blocked here.
      if (isAlreadyExistsError(e)) {
        forwardData = { forwardingEmail: targetUser, alreadyExisted: true };
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        audit({
          action: "email_transfer.create_forwarding",
          tenantId: tenant?.id ?? null,
          tenantName: tenant?.name ?? null,
          params: { sourceUser, targetUser, isExternal },
          outcome: "error",
          error: msg,
        });
        return NextResponse.json({
          success: false,
          error: `Failed to create forwarding address: ${msg}`,
          step: "create_forwarding",
        });
      }
    }

    // Step 2: Enable auto-forwarding.
    let autoForwardData: unknown;
    let autoForwardError: string | undefined;
    try {
      const res = await gmail.users.settings.updateAutoForwarding({
        userId: "me",
        requestBody: {
          enabled: true,
          emailAddress: targetUser,
          disposition: DISPOSITION_MAP[action],
        },
      });
      autoForwardData = res.data;
    } catch (e) {
      autoForwardError = e instanceof Error ? e.message : String(e);
    }

    audit({
      action: "email_transfer.enable",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { sourceUser, targetUser, action, isExternal },
      outcome: autoForwardError ? "error" : "success",
      error: autoForwardError,
    });

    return NextResponse.json({
      success: !autoForwardError,
      data: { forwardingAddress: forwardData, autoForwarding: autoForwardData, isExternal },
      error: autoForwardError,
    });
  } catch (e) {
    audit({
      action: "email_transfer",
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
