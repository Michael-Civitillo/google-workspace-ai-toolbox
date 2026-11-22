import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { tenantFromRequest } from "@/lib/gws";
import {
  assignLicense,
  licensingSetupProblem,
  LICENSING_SCOPE,
  listLicenseAssignments,
  removeLicense,
} from "@/lib/admin-sdk";
import { isKnownProduct } from "@/lib/licenses";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { errorResponse } from "@/lib/api-errors";
import { actorFromRequest } from "@/lib/session";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * Licences.
 *
 * GET    /api/admin/licenses?product=<id>&pageToken=<token>
 *          One page of the accounts holding a licence of one product.
 * POST   /api/admin/licenses  { user, productId, skuId, confirm }
 *          Give an account a licence.
 * DELETE /api/admin/licenses  { user, productId, skuId, confirm }
 *          Take one away.
 *
 * A licence is paid for and removing one can cost someone their data, so both
 * changes take the typed confirmation the destructive routes do: `confirm`
 * must equal `user`, checked here and not only in the browser.
 *
 * Two failures are setup, not faults, and are answered as 403 with a `code`
 * the page turns into instructions: the licensing permission hasn't been
 * authorised for the key ("scope_missing"), or the licensing API is off in
 * the key's Google Cloud project ("api_disabled").
 */
const MAX_BODY_BYTES = 16 * 1024;

function failure(e: unknown): NextResponse {
  const code = licensingSetupProblem(e);
  if (!code) return errorResponse(e);
  return NextResponse.json(
    {
      success: false,
      code,
      scope: LICENSING_SCOPE,
      error:
        code === "scope_missing"
          ? "Open Admin's key has not been given permission to manage licences."
          : "The Enterprise License Manager API is switched off in the Google Cloud project this key belongs to.",
      detail: e instanceof Error ? e.message.slice(0, 500) : null,
    },
    { status: 403 }
  );
}

export async function GET(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  try {
    const tenant = tenantFromRequest(request);
    const product = request.nextUrl.searchParams.get("product");
    if (!isKnownProduct(product)) {
      throw new ValidationError("product is not one Open Admin asks about");
    }
    const pageToken = request.nextUrl.searchParams.get("pageToken") || undefined;
    if (pageToken && pageToken.length > 2048) {
      throw new ValidationError("pageToken is too long");
    }
    const page = await listLicenseAssignments(tenant, {
      productId: product,
      pageToken,
      signal: request.signal,
    });
    return NextResponse.json({ success: true, data: page });
  } catch (e) {
    return failure(e);
  }
}

async function change(request: NextRequest, kind: "assign" | "remove") {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  const action = kind === "assign" ? "licenses.assign" : "licenses.remove";
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
    const user = requireEmail(body.user, "user").toLowerCase();
    const productId = typeof body.productId === "string" ? body.productId : "";
    const skuId = typeof body.skuId === "string" ? body.skuId : "";
    const confirm =
      typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
    if (confirm !== user) {
      throw new ValidationError(
        "Type the user's email address into the confirm field to proceed."
      );
    }

    const target = { user, productId, skuId };
    const data =
      kind === "assign"
        ? await assignLicense(tenant, target)
        : await removeLicense(tenant, target);

    audit({
      action,
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user, productId, skuId, skuName: data.skuName },
      outcome: "success",
      actor,
    });
    return NextResponse.json({ success: true, data });
  } catch (e) {
    audit({
      action,
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: boundedParams(body),
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
      actor,
    });
    return failure(e);
  }
}

export const POST = (request: NextRequest) => change(request, "assign");
export const DELETE = (request: NextRequest) => change(request, "remove");
