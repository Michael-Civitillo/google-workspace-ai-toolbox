import { NextRequest, NextResponse } from "next/server";
import { listExternallySharedFiles } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";

/**
 * Per-user external-sharing audit.
 *
 * GET /api/admin/sharing-audit?user=alice@yourdomain.com
 *
 * Read-only. Returns Drive files (owned by the user) that have at least one
 * permission outside the tenant's verified domains: link-shared ("anyone"),
 * shared with an external domain, or shared with an external user/group.
 * Capped server-side at 1,000 files scanned to keep latency bounded.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const user = requireEmail(
      request.nextUrl.searchParams.get("user"),
      "user"
    );
    const result = await listExternallySharedFiles(tenant, user);
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sharing audit failed";
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
