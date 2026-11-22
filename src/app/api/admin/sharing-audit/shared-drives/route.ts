import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { listSharedDrives, SHARED_DRIVES_MAX_PAGE } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { ValidationError } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";

/**
 * Sharing audit: the tenant's shared drives and who outside the organisation
 * is a member of each.
 *
 * GET /api/admin/sharing-audit/shared-drives[?pageToken=...][&pageSize=20]
 *
 * Read-only. One page of drives per call; the client chains on
 * `nextPageToken`, then scans each drive's files through the sibling
 * /files route.
 */
export async function GET(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  try {
    const tenant = tenantFromRequest(request);
    const params = request.nextUrl.searchParams;

    const rawPageToken = params.get("pageToken");
    let pageToken: string | undefined;
    if (rawPageToken !== null) {
      if (rawPageToken.length === 0 || rawPageToken.length > 4096) {
        throw new ValidationError("pageToken is malformed");
      }
      pageToken = rawPageToken;
    }
    const pageSizeRaw = params.get("pageSize");
    let pageSize: number | undefined;
    if (pageSizeRaw) {
      const n = Number(pageSizeRaw);
      if (!Number.isInteger(n)) throw new ValidationError("pageSize must be an integer");
      pageSize = Math.min(SHARED_DRIVES_MAX_PAGE, Math.max(1, n));
    }

    const page = await listSharedDrives(tenant, {
      pageToken,
      pageSize,
      signal: request.signal,
    });
    return NextResponse.json(
      { success: true, data: page },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    return errorResponse(e, "Could not list shared drives");
  }
}
