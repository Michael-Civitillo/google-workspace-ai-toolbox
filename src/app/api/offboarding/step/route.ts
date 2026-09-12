import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import type { Tenant } from "@/lib/tenant-types";
import {
  buildGmailClient,
  buildCalendarClient,
  removeUserFromAllGroups,
  revokeAllOAuthTokens,
  signOutAllSessions,
  suspendUser,
  transferDrive,
  getUser,
  isAlreadyExistsError,
  isExternalTarget,
  withGoogleRetry,
} from "@/lib/admin-sdk";
import {
  requireEmail,
  ValidationError,
  emailDomain,
} from "@/lib/validate";
import { audit } from "@/lib/audit";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";
import { actorFromRequest } from "@/lib/session";

const MAX_BODY_BYTES = 16 * 1024;

// Steps that impersonate the departing user rather than acting on them from
// the admin's side. Google refuses to mint a token for a suspended account, so
// these only work while the account is still active.
const SETTINGS_STEPS: ReadonlySet<string> = new Set([
  "vacation",
  "forward",
  "calendar",
]);

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
 *   step: "vacation" | "forward" | "calendar" | "drive" | "groups"
 *       | "revokeTokens" | "signOut" | "suspend",
 *   user: string,                         // user being offboarded
 *   confirm: string,                      // must equal `user` (typed confirmation)
 *   successor?: string,                   // for forward/calendar/drive
 *   vacationSubject?: string,             // for vacation
 *   vacationMessage?: string,             // for vacation
 *   calendarRemoveSourceAccess?: boolean, // for calendar (always false here)
 * }
 */
export async function POST(request: NextRequest) {
  const actor = await actorFromRequest(request);
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }

  let tenant: Tenant | null = null;
  const step = String(body.step || "");
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");

    // Suspending, revoking or forwarding the impersonated admin's own account
    // would cut the domain-wide delegation this tool runs on and lock every
    // future operation out of the tenant — refuse before anything runs.
    if (tenant?.adminEmail && user === tenant.adminEmail.toLowerCase()) {
      throw new ValidationError(
        `"${user}" is this tenant's domain-wide-delegation admin. Offboarding it would lock Open Admin out of the tenant — move delegation to another admin first.`
      );
    }

    // Every step here is destructive or hard to undo (suspend, password/token
    // revoke, mail forwarding, Drive transfer, group removal). The browser
    // shows a typed-confirmation dialog, but this route accepts anything
    // holding a session cookie, so require the same typed confirmation
    // server-side before the first Google call.
    const confirmedUser =
      typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
    if (confirmedUser !== user) {
      throw new ValidationError(
        "Type the user's email address into the confirm field to proceed."
      );
    }

    // Impersonation stops working the moment an account is suspended, so the
    // settings steps have to run before "suspend". That order lived only in the
    // page; check it here too, or an out-of-order call gets an opaque Google
    // error instead of the reason.
    if (SETTINGS_STEPS.has(step)) {
      const target = await getUser(tenant, user);
      if (target.suspended) {
        throw new ValidationError(
          `"${user}" is already suspended, and Google will not impersonate a suspended account. Un-suspend it to run this step, or skip to the steps that act on the admin's behalf (Drive transfer, groups, token revoke).`
        );
      }
    }

    const userDomain = emailDomain(user);
    const auditBase = {
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
    };

    // Forwarding mail to — or granting calendar ownership to — a successor
    // outside the tenant's verified domains sends data to an outsider. Mirror
    // the email-transfer guard: require an explicit typed confirmExternal for an
    // external successor. Fail-closed if domains can't be enumerated.
    const requireInternalOrConfirmed = async (successor: string) => {
      if (await isExternalTarget(tenant, successor)) {
        const confirm =
          typeof body.confirmExternal === "string"
            ? body.confirmExternal.trim().toLowerCase()
            : "";
        if (confirm !== successor.toLowerCase()) {
          throw new ValidationError(
            `Successor "${successor}" is outside this tenant's verified domains. Set confirmExternal to the exact successor email to proceed.`
          );
        }
      }
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
          // Gmail throttles per user: back off on rate limits instead of
          // failing the step (and holding back the rest of the sequence) on
          // the first 429. Setting the responder is idempotent, so 5xx blips
          // retry too.
          await withGoogleRetry(
            () =>
              gmail.users.settings.updateVacation({
                userId: "me",
                requestBody: {
                  enableAutoReply: true,
                  responseSubject: subject,
                  responseBodyPlainText: message,
                  restrictToContacts: false,
                  restrictToDomain: false,
                },
              }),
            { retryServerErrors: true }
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          audit({
            action: "offboarding.vacation",
            ...auditBase,
            params: { user, subject },
            outcome: "error",
            error: msg,
            actor,
          });
          return NextResponse.json(
            {
              success: false,
              error: msg || "Failed to enable vacation responder",
            },
            { status: 502 }
          );
        }
        audit({
          action: "offboarding.vacation",
          ...auditBase,
          params: { user, subject },
          outcome: "success",
          actor,
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
        await requireInternalOrConfirmed(successor);
        const gmail = buildGmailClient(tenant, user, GMAIL_FORWARDING_SCOPES);

        // Step 1: register the forwarding address on the source mailbox. A
        // same-domain successor is auto-verified when the address is created
        // via domain-wide delegation, so no confirmation email is needed. An
        // EXTERNAL successor starts "pending" until they accept Gmail's
        // verification email — enabling auto-forwarding before that fails
        // opaquely, so the pending state is surfaced as the step's outcome.
        let verificationStatus: string | null = null;
        try {
          // Rate-limit retries only: the create is not idempotent.
          const created = await withGoogleRetry(
            () =>
              gmail.users.settings.forwardingAddresses.create({
                userId: "me",
                requestBody: { forwardingEmail: successor },
              }),
            { retryServerErrors: false }
          );
          verificationStatus = created.data.verificationStatus ?? null;
        } catch (e) {
          // An "already exists" error means a previous run registered the
          // address — proceed to enabling auto-forwarding so the step is
          // retry-safe rather than wedging on the duplicate.
          if (isAlreadyExistsError(e)) {
            try {
              const existing = await withGoogleRetry(
                () =>
                  gmail.users.settings.forwardingAddresses.get({
                    userId: "me",
                    forwardingEmail: successor,
                  }),
                { retryServerErrors: true }
              );
              verificationStatus = existing.data.verificationStatus ?? null;
            } catch {
              verificationStatus = null;
            }
          }
          if (!isAlreadyExistsError(e)) {
            const msg = e instanceof Error ? e.message : String(e);
            audit({
              action: "offboarding.forward.create",
              ...auditBase,
              params: { user, successor },
              outcome: "error",
              error: msg,
              actor,
            });
            return NextResponse.json(
              {
                success: false,
                error: `Failed to create forwarding address: ${msg}`,
              },
              { status: 502 }
            );
          }
        }

        if (verificationStatus === "pending") {
          audit({
            action: "offboarding.forward.pending_verification",
            ...auditBase,
            params: { user, successor },
            outcome: "success",
            actor,
          });
          return NextResponse.json({
            success: false,
            data: { successor, pendingVerification: true },
            error:
              `Gmail sent a verification email to ${successor}. ` +
              "Forwarding can't be enabled until they accept it — " +
              "re-run this step once they have.",
          });
        }

        // Step 2: enable auto-forwarding and archive the originals.
        try {
          // Setting the forwarding state is idempotent: retry 5xx blips too.
          await withGoogleRetry(
            () =>
              gmail.users.settings.updateAutoForwarding({
                userId: "me",
                requestBody: {
                  enabled: true,
                  emailAddress: successor,
                  disposition: "archive",
                },
              }),
            { retryServerErrors: true }
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          audit({
            action: "offboarding.forward",
            ...auditBase,
            params: { user, successor },
            outcome: "error",
            error: msg,
            actor,
          });
          return NextResponse.json(
            {
              success: false,
              data: { successor, disposition: "archive" },
              error: msg,
            },
            { status: 502 }
          );
        }
        audit({
          action: "offboarding.forward",
          ...auditBase,
          params: { user, successor },
          outcome: "success",
          actor,
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
        await requireInternalOrConfirmed(successor);
        // Grant ownership only — never auto-remove the source user's access
        // during offboarding. Suspending the account already cuts them off;
        // dropping the ACL on a primary calendar would be rejected anyway.
        try {
          const cal = buildCalendarClient(tenant, user);
          // Rate-limit retries only: never re-send a write after a 5xx that
          // may have committed.
          await withGoogleRetry(
            () =>
              cal.acl.insert({
                calendarId: user,
                requestBody: {
                  role: "owner",
                  scope: { type: "user", value: successor },
                },
              }),
            { retryServerErrors: false }
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          audit({
            action: "offboarding.calendar",
            ...auditBase,
            params: { user, successor },
            outcome: "error",
            error: msg,
            actor,
          });
          return NextResponse.json(
            {
              success: false,
              data: { successor, role: "owner" },
              error: msg,
            },
            { status: 502 }
          );
        }
        audit({
          action: "offboarding.calendar",
          ...auditBase,
          params: { user, successor },
          outcome: "success",
          actor,
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
        // Handing an entire Drive to an address outside the verified domains is
        // the largest data egress of any step — gate it like forward/calendar.
        await requireInternalOrConfirmed(successor);
        const result = await transferDrive(tenant, user, successor);
        audit({
          action: "offboarding.drive",
          ...auditBase,
          params: { user, successor, transferId: result.transferId },
          outcome: "success",
          actor,
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

      case "groups": {
        const result = await removeUserFromAllGroups(tenant, user);
        // A truncated run is NOT complete: memberships past the per-run cap
        // remain, so reporting success would let the operator move on with
        // the user still on mailing lists and access groups.
        const complete = result.failed === 0 && !result.truncated;
        const errorParts: string[] = [];
        if (result.failed > 0) {
          errorParts.push(
            `${result.failed} of ${result.removed + result.failed} group removals failed`
          );
        }
        if (result.truncated) {
          errorParts.push(
            "the user belongs to more groups than one run can process — run this step again to remove the remainder"
          );
        }
        audit({
          action: "offboarding.groups",
          ...auditBase,
          params: { user, ...result },
          outcome: complete ? "success" : "error",
          error: errorParts.length > 0 ? errorParts.join("; ") : undefined,
          actor,
        });
        return NextResponse.json(
          {
            success: complete,
            data: {
              ...result,
              message: `Removed from ${result.removed} group${result.removed === 1 ? "" : "s"}${result.truncated ? " (more remain)" : ""}`,
            },
            error: errorParts.length > 0 ? errorParts.join("; ") : undefined,
          },
          { status: result.failed > 0 ? 502 : 200 }
        );
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
          actor,
        });
        return NextResponse.json(
          {
            success: result.failed === 0,
            data: result,
            error: result.failed > 0
              ? `${result.failed} of ${result.revoked + result.failed} tokens failed to revoke`
              : undefined,
          },
          { status: result.failed > 0 ? 502 : 200 }
        );
      }

      case "signOut": {
        await signOutAllSessions(tenant, user);
        audit({
          action: "offboarding.signOut",
          ...auditBase,
          params: { user },
          outcome: "success",
          actor,
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
          actor,
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
      // Record the identifiers, not the raw body: a 5,000-character vacation
      // message (or any unexpected field) has no place in the audit log.
      params: {
        step,
        user: typeof body.user === "string" ? body.user : null,
        successor: typeof body.successor === "string" ? body.successor : null,
      },
      outcome: "error",
      error: message,
      actor,
    });
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
