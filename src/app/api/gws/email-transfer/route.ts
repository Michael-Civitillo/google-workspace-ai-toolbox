import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import {
  buildGmailClient,
  isAlreadyExistsError,
  isExternalTarget,
  withGoogleRetry,
} from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { constantTimeStringEqual } from "@/lib/auth";
import { errorResponse } from "@/lib/api-errors";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";
import { actorFromRequest } from "@/lib/session";

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
  const actor = await actorFromRequest(request);
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
    let verificationStatus: string | null = null;
    try {
      // Rate-limit retries only for the create (not idempotent); the status
      // lookup and the settings update below are safe to retry on 5xx too.
      const res = await withGoogleRetry(
        () =>
          gmail.users.settings.forwardingAddresses.create({
            userId: "me",
            requestBody: { forwardingEmail: targetUser },
          }),
        { retryServerErrors: false }
      );
      forwardData = res.data;
      verificationStatus = res.data.verificationStatus ?? null;
    } catch (e) {
      // A duplicate means a previous attempt already registered the address —
      // continue to enabling auto-forwarding so a retry isn't blocked here.
      if (isAlreadyExistsError(e)) {
        forwardData = { forwardingEmail: targetUser, alreadyExisted: true };
        // The duplicate error doesn't say whether the recipient has verified
        // yet, and enabling with a pending address fails opaquely — look the
        // status up. Best-effort: an unreadable status falls through to the
        // enable attempt, which reports its own error.
        try {
          const existing = await withGoogleRetry(
            () =>
              gmail.users.settings.forwardingAddresses.get({
                userId: "me",
                forwardingEmail: targetUser,
              }),
            { retryServerErrors: true }
          );
          verificationStatus = existing.data.verificationStatus ?? null;
        } catch {
          verificationStatus = null;
        }
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        audit({
          action: "email_transfer.create_forwarding",
          tenantId: tenant?.id ?? null,
          tenantName: tenant?.name ?? null,
          params: { sourceUser, targetUser, isExternal },
          actor,
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

    // An out-of-org forwarding address starts life "pending": Gmail emails
    // the recipient a confirmation link, and auto-forwarding cannot be
    // enabled until they accept. Attempting the enable anyway fails with an
    // opaque Google error — return the real state and next step instead.
    if (verificationStatus === "pending") {
      audit({
        action: "email_transfer.pending_verification",
        tenantId: tenant?.id ?? null,
        tenantName: tenant?.name ?? null,
        params: { sourceUser, targetUser, action, isExternal },
        actor,
        outcome: "success",
      });
      return NextResponse.json({
        success: false,
        data: { forwardingAddress: forwardData, isExternal, pendingVerification: true },
        error:
          `Gmail sent a verification email to ${targetUser}. ` +
          "Auto-forwarding can't be enabled until the recipient accepts it — " +
          "re-run this transfer once they have.",
        step: "verify_forwarding",
      });
    }

    // Step 2: Enable auto-forwarding.
    let autoForwardData: unknown;
    let autoForwardError: string | undefined;
    try {
      // Setting the forwarding state is idempotent, so 5xx blips retry too.
      const res = await withGoogleRetry(
        () =>
          gmail.users.settings.updateAutoForwarding({
            userId: "me",
            requestBody: {
              enabled: true,
              emailAddress: targetUser,
              disposition: DISPOSITION_MAP[action],
            },
          }),
        { retryServerErrors: true }
      );
      autoForwardData = res.data;
    } catch (e) {
      autoForwardError = e instanceof Error ? e.message : String(e);
    }

    audit({
      action: "email_transfer.enable",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { sourceUser, targetUser, action, isExternal },
      actor,
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
      params: boundedParams(body),
      actor,
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e);
  }
}
