import { NextRequest, NextResponse } from "next/server";
import { listExternallySharedFiles } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";

/**
 * Per-user external-sharing audit.
 *
 * GET /api/admin/sharing-audit?user=alice@yourdomain.com&pageToken=...
 *
 * Read-only. Returns Drive files (owned by the user) that have at least one
 * permission outside the tenant's verified domains: link-shared ("anyone"),
 * shared with an external domain, or shared with an external user/group.
 *
 * Capped server-side at 1,000 files scanned per request to keep latency
 * bounded. When the user's Drive is bigger than the cap, the response
 * includes `nextPageToken` so the client can chain a follow-up call to
 * continue from where this one stopped.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const user = requireEmail(
      request.nextUrl.searchParams.get("user"),
      "user"
    );
    const rawPageToken = request.nextUrl.searchParams.get("pageToken");
    // Drive page tokens are short opaque strings; reject obvious junk early.
    let pageToken: string | undefined;
    if (rawPageToken !== null) {
      if (rawPageToken.length === 0 || rawPageToken.length > 4096) {
        throw new ValidationError("pageToken is malformed");
      }
      pageToken = rawPageToken;
    }
    const result = await listExternallySharedFiles(tenant, user, pageToken);
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sharing audit failed";
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
