import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import {
  buildGmailClient,
  isAlreadyExistsError,
  isExternalTarget,
} from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";
import { constantTimeStringEqual } from "@/lib/auth";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

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

/**
 * Set up email forwarding from source to target user.
 *
 * Auto-forwarding to an external domain is a major data-exfiltration risk.
 * If the target domain is not one of this tenant's verified domains, the
 * caller must explicitly opt in with `confirmExternal: "<target email>"`.
 */
export async function POST(request: NextRequest) {
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }
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

    // External-domain check (shared, fail-closed helper).
    const isExternal = await isExternalTarget(tenant, targetUser);

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
        return NextResponse.json(
          {
            success: false,
            error: `Failed to create forwarding address: ${msg}`,
            step: "create_forwarding",
          },
          // 502: the failure is upstream (Google), not a bad client request. Use
          // a real error status so monitors keying on res.ok don't read it as
          // success — the body still carries success:false and the step.
          { status: 502 }
        );
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

    return NextResponse.json(
      {
        success: !autoForwardError,
        data: { forwardingAddress: forwardData, autoForwarding: autoForwardData, isExternal },
        error: autoForwardError,
      },
      // The forwarding address was created; enabling auto-forwarding is what
      // failed upstream. Signal that with 502 so the status matches the body.
      { status: autoForwardError ? 502 : 200 }
    );
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
