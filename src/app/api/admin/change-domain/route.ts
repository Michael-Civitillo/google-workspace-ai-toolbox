import { NextRequest, NextResponse } from "next/server";
import { changePrimaryDomain } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import {
  requireEmail,
  requireDomain,
  requireUsername,
  ValidationError,
} from "@/lib/validate";
import { audit } from "@/lib/audit";

/**
 * Change a user's primary domain.
 *
 * Server-side preflight (in admin-sdk.changePrimaryDomain): user exists,
 * domain is verified, new email isn't taken, target user is not the admin
 * we're impersonating, read-after-write.
 *
 * In addition this route requires `confirm` to equal the user's current email
 * — a typed confirmation that prevents accidental clicks/auto-submits from
 * firing an irreversible primary-email change.
 */
// Domain-change bodies are tiny — cap aggressively so a malicious caller
// can't stream a huge payload that then gets echoed into audit.log.
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: NextRequest) {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }
  let raw = "";
  try {
    raw = await request.text();
  } catch {}
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }
  let body: Record<string, unknown> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {}

  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const currentEmail = requireEmail(body.currentEmail, "currentEmail");
    const newDomain = requireDomain(body.newDomain, "newDomain");
    let newUsername: string | undefined;
    if (body.newUsername !== undefined && body.newUsername !== "") {
      newUsername = requireUsername(body.newUsername, "newUsername");
    }

    const confirm =
      typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
    if (confirm !== currentEmail) {
      throw new ValidationError(
        "Type the user's current email address into the confirm field to proceed."
      );
    }

    const result = await changePrimaryDomain(
      tenant,
      currentEmail,
      newDomain,
      newUsername
    );

    audit({
      action: "domain_change",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {
        currentEmail,
        newDomain,
        newUsername: newUsername ?? null,
        previousEmail: result.previousEmail,
        newEmail: result.newEmail,
        verifiedNewPrimary: result.verifiedNewPrimary,
      },
      outcome: "success",
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to change domain";
    audit({
      action: "domain_change",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: body,
      outcome: "error",
      error: message,
    });
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
