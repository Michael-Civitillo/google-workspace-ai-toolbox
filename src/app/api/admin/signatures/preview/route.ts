import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { previewSignature } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * What a signature template would give one person, next to what they have.
 *
 * POST /api/admin/signatures/preview  { user, template }
 *
 * Read-only: it reads the person's directory profile and current signature
 * and changes nothing. (POST only because a template doesn't belong in a URL.)
 */
const MAX_BODY_BYTES = 32 * 1024;

export async function POST(request: NextRequest) {
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }
  try {
    const tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user").toLowerCase();
    if (typeof body.template !== "string") {
      throw new ValidationError("template must be text");
    }
    const preview = await previewSignature(tenant, user, body.template);
    return NextResponse.json({ success: true, data: preview });
  } catch (e) {
    return errorResponse(e);
  }
}
