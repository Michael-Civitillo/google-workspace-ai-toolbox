import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { listGroups } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";

/**
 * List groups in the tenant (optionally narrowed by a Directory query), or —
 * with `userKey` — the groups a specific user is a direct member of.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const params = request.nextUrl.searchParams;

    const pageToken = params.get("pageToken") || undefined;
    const pageSizeRaw = params.get("pageSize");
    let pageSize: number | undefined;
    if (pageSizeRaw !== null && pageSizeRaw !== "") {
      const n = Number(pageSizeRaw);
      if (!Number.isInteger(n)) {
        throw new ValidationError("pageSize must be an integer");
      }
      pageSize = Math.min(200, Math.max(1, n));
    }

    const userKeyRaw = params.get("userKey");
    const userKey = userKeyRaw ? requireEmail(userKeyRaw, "userKey") : undefined;
    const query = params.get("query")?.slice(0, 200) || undefined;
    if (userKey && query) {
      throw new ValidationError("query cannot be combined with userKey");
    }

    const result = await listGroups(tenant, {
      pageToken,
      pageSize,
      query,
      userKey,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  const message = e instanceof Error ? e.message : "Unexpected error";
  const status = e instanceof ValidationError ? 400 : 500;
  return NextResponse.json({ success: false, error: message }, { status });
}
