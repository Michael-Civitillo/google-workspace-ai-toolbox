import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import {
  buildGmailClient,
  buildCalendarClient,
  revokeAllOAuthTokens,
  signOutAllSessions,
  suspendUser,
  transferDrive,
  isAlreadyExistsError,
} from "@/lib/admin-sdk";
import {
  requireEmail,
  ValidationError,
  emailDomain,
} from "@/lib/validate";
import { audit } from "@/lib/audit";

const MAX_BODY_BYTES = 16 * 1024;

// Minimal Gmail scopes per operation, mirroring the email-transfer/-delegation
// routes: creating a forwarding address needs the "sharing" scope, while the
// vacation responder needs "basic".
const GMAIL_FORWARDING_SCOPES = [
  "https://www.googleapis.com/auth/gmail.settings.sharing",
];
const GMAIL_VACATION_SCOPES = [
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

/**
 * Run a single offboarding step. The client orchestrates the sequence and
 * shows per-step status; running them server-side one-at-a-time means we
 * keep the audit trail granular and a partial failure halfway through
 * leaves the rest of the steps explicit and recoverable.
 *
 * Body: {
 *   step: "vacation" | "forward" | "calendar" | "drive" | "revokeTokens"
 *       | "signOut" | "suspend",
 *   user: string,                         // user being offboarded
 *   successor?: string,                   // for forward/calendar/drive
 *   vacationSubject?: string,             // for vacation
 *   vacationMessage?: string,             // for vacation
 *   calendarRemoveSourceAccess?: boolean, // for calendar (always false here)
 * }
 */
export async function POST(request: NextRequest) {
  // Cheap header reject, then enforce the cap on the bytes actually read —
  // a chunked request can omit/understate Content-Length.
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }

  let raw = "";
  try {
    raw = await request.text();
  } catch {}
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  let body: Record<string, unknown> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {}

  let tenant = null;
  const step = String(body.step || "");
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");

    const userDomain = emailDomain(user);
    const auditBase = {
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
    };

    switch (step) {
      case "vacation": {
        const subject = String(
          body.vacationSubject ?? "Out of office"
        ).slice(0, 200);
        const message = String(
          body.vacationMessage ??
            "I'm no longer with the company. Please contact our team for any questions."
        ).slice(0, 5000);
        try {
          const gmail = buildGmailClient(tenant, user, GMAIL_VACATION_SCOPES);
          await gmail.users.settings.updateVacation({
            userId: "me",
            requestBody: {
              enableAutoReply: true,
              responseSubject: subject,
              responseBodyPlainText: message,
              restrictToContacts: false,
              restrictToDomain: false,
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          audit({
            action: "offboarding.vacation",
            ...auditBase,
            params: { user, subject },
            outcome: "error",
            error: msg,
          });
          return NextResponse.json({
            success: false,
            error: msg || "Failed to enable vacation responder",
          });
        }
        audit({
          action: "offboarding.vacation",
          ...auditBase,
          params: { user, subject },
          outcome: "success",
        });
        return NextResponse.json({
          success: true,
          data: { message: "Vacation responder enabled" },
        });
      }

      case "forward": {
        const successor = requireEmail(body.successor, "successor");
        if (successor.toLowerCase() === user.toLowerCase()) {
          throw new ValidationError("successor must differ from user");
        }
        const gmail = buildGmailClient(tenant, user, GMAIL_FORWARDING_SCOPES);

        // Step 1: register the forwarding address on the source mailbox. A
        // same-domain successor is auto-verified when the address is created
        // via domain-wide delegation, so no confirmation email is needed.
        try {
          await gmail.users.settings.forwardingAddresses.create({
            userId: "me",
            requestBody: { forwardingEmail: successor },
          });
        } catch (e) {
          // An "already exists" error means a previous run registered the
          // address — proceed to enabling auto-forwarding so the step is
          // retry-safe rather than wedging on the duplicate.
          if (!isAlreadyExistsError(e)) {
            const msg = e instanceof Error ? e.message : String(e);
            audit({
              action: "offboarding.forward.create",
              ...auditBase,
              params: { user, successor },
              outcome: "error",
              error: msg,
            });
            return NextResponse.json({
              success: false,
              error: `Failed to create forwarding address: ${msg}`,
            });
          }
        }

        // Step 2: enable auto-forwarding and archive the originals.
        try {
          await gmail.users.settings.updateAutoForwarding({
            userId: "me",
            requestBody: {
              enabled: true,
              emailAddress: successor,
              disposition: "archive",
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          audit({
            action: "offboarding.forward",
            ...auditBase,
            params: { user, successor },
            outcome: "error",
            error: msg,
          });
          return NextResponse.json({
            success: false,
            data: { successor, disposition: "archive" },
            error: msg,
          });
        }
        audit({
          action: "offboarding.forward",
          ...auditBase,
          params: { user, successor },
          outcome: "success",
        });
        return NextResponse.json({
          success: true,
          data: { successor, disposition: "archive" },
        });
      }

      case "calendar": {
        const successor = requireEmail(body.successor, "successor");
        if (successor.toLowerCase() === user.toLowerCase()) {
          throw new ValidationError("successor must differ from user");
        }
        // Grant ownership only — never auto-remove the source user's access
        // during offboarding. Suspending the account already cuts them off;
        // dropping the ACL on a primary calendar would be rejected anyway.
        try {
          const cal = buildCalendarClient(tenant, user);
          await cal.acl.insert({
            calendarId: user,
            requestBody: {
              role: "owner",
              scope: { type: "user", value: successor },
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          audit({
            action: "offboarding.calendar",
            ...auditBase,
            params: { user, successor },
            outcome: "error",
            error: msg,
          });
          return NextResponse.json({
            success: false,
            data: { successor, role: "owner" },
            error: msg,
          });
        }
        audit({
          action: "offboarding.calendar",
          ...auditBase,
          params: { user, successor },
          outcome: "success",
        });
        return NextResponse.json({
          success: true,
          data: { successor, role: "owner" },
        });
      }

      case "drive": {
        const successor = requireEmail(body.successor, "successor");
        if (successor.toLowerCase() === user.toLowerCase()) {
          throw new ValidationError("successor must differ from user");
        }
        const result = await transferDrive(tenant, user, successor);
        audit({
          action: "offboarding.drive",
          ...auditBase,
          params: { user, successor, transferId: result.transferId },
          outcome: "success",
        });
        return NextResponse.json({
          success: true,
          data: {
            successor,
            transferId: result.transferId,
            note: "Drive transfer accepted by Google. Files move asynchronously over the next minutes/hours depending on volume.",
          },
        });
      }

      case "revokeTokens": {
        const result = await revokeAllOAuthTokens(tenant, user);
        audit({
          action: "offboarding.revokeTokens",
          ...auditBase,
          params: { user, ...result },
          outcome: result.failed === 0 ? "success" : "error",
          error: result.failed > 0
            ? `${result.failed} token(s) failed to revoke`
            : undefined,
        });
        return NextResponse.json({
          success: result.failed === 0,
          data: result,
          error: result.failed > 0
            ? `${result.failed} of ${result.revoked + result.failed} tokens failed to revoke`
            : undefined,
        });
      }

      case "signOut": {
        await signOutAllSessions(tenant, user);
        audit({
          action: "offboarding.signOut",
          ...auditBase,
          params: { user },
          outcome: "success",
        });
        return NextResponse.json({
          success: true,
          data: { message: "All sessions signed out" },
        });
      }

      case "suspend": {
        await suspendUser(tenant, user);
        audit({
          action: "offboarding.suspend",
          ...auditBase,
          params: { user },
          outcome: "success",
        });
        return NextResponse.json({
          success: true,
          data: { message: "User suspended" },
        });
      }

      default:
        throw new ValidationError(`Unknown offboarding step: "${step}"`);
    }
    // Unreachable, but keeps TS happy if cases are added without returns.
    void userDomain;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Step failed";
    audit({
      action: `offboarding.${step || "unknown"}`,
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: body,
      outcome: "error",
      error: message,
    });
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
