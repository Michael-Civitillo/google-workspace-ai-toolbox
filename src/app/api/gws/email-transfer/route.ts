import { NextRequest, NextResponse } from "next/server";
import { gws, tenantFromRequest } from "@/lib/gws";
import { listDomains } from "@/lib/admin-sdk";
import { requireEmail, ValidationError, emailDomain } from "@/lib/validate";
import { audit } from "@/lib/audit";

const ALLOWED_ACTIONS = new Set(["keep", "archive", "trash", "markRead"]);

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const user = requireEmail(
      request.nextUrl.searchParams.get("user"),
      "user"
    );
    const result = await gws(
      ["gmail", "users", "labels", "list", `--userId=${user}`],
      tenant
    );
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Set up email forwarding from source to target user.
 *
 * Auto-forwarding to an external domain is a major data-exfiltration risk —
 * the previous version of this route accepted any target email with no
 * domain check. Now: if the target domain is not one of this tenant's
 * verified domains, the caller must explicitly opt in with
 * `confirmExternal: "<target email>"` to confirm they typed it correctly.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
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
      // If we can't enumerate domains, fail closed: treat as external. Better
      // to require explicit confirmation than to silently forward outside.
      isExternal = true;
      console.warn(
        "email-transfer: could not list domains, treating target as external:",
        e
      );
    }

    if (isExternal) {
      const confirm = typeof body.confirmExternal === "string"
        ? body.confirmExternal.trim().toLowerCase()
        : "";
      if (confirm !== targetUser) {
        throw new ValidationError(
          `Target "${targetUser}" is outside this tenant's verified domains. Set confirmExternal to the exact target email to proceed.`
        );
      }
    }

    // Step 1: Create forwarding address.
    const forwardResult = await gws(
      [
        "gmail",
        "users",
        "settings",
        "forwardingAddresses",
        "create",
        `--userId=${sourceUser}`,
        `--forwardingEmail=${targetUser}`,
      ],
      tenant
    );

    if (!forwardResult.success) {
      audit({
        action: "email_transfer.create_forwarding",
        tenantId: tenant?.id ?? null,
        tenantName: tenant?.name ?? null,
        params: { sourceUser, targetUser, isExternal },
        outcome: "error",
        error: forwardResult.error,
      });
      return NextResponse.json({
        success: false,
        error: `Failed to create forwarding address: ${forwardResult.error}`,
        step: "create_forwarding",
      });
    }

    const dispositionMap: Record<string, string> = {
      keep: "leaveInInbox",
      archive: "archive",
      trash: "trash",
      markRead: "markRead",
    };

    // Step 2: Enable auto-forwarding.
    const enableResult = await gws(
      [
        "gmail",
        "users",
        "settings",
        "updateAutoForwarding",
        `--userId=${sourceUser}`,
        `--enabled=true`,
        `--emailAddress=${targetUser}`,
        `--disposition=${dispositionMap[action]}`,
      ],
      tenant
    );

    audit({
      action: "email_transfer.enable",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { sourceUser, targetUser, action, isExternal },
      outcome: enableResult.success ? "success" : "error",
      error: enableResult.error,
    });

    return NextResponse.json({
      success: enableResult.success,
      data: {
        forwardingAddress: forwardResult.data,
        autoForwarding: enableResult.data,
        isExternal,
      },
      error: enableResult.success ? undefined : enableResult.error,
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
