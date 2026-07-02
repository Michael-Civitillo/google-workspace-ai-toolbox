import { NextRequest, NextResponse } from "next/server";
import { listUsers } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { ValidationError } from "@/lib/validate";

/**
 * Page through tenant users.
 *
 * GET /api/admin/users?pageToken=...&pageSize=500
 *
 * Read-only. Used by the tenant-wide sharing audit to enumerate every
 * mailbox to scan, but generic enough to feed any future tenant-wide flow.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const pageToken = request.nextUrl.searchParams.get("pageToken") || undefined;
    const pageSizeRaw = request.nextUrl.searchParams.get("pageSize");
    let pageSize: number | undefined;
    if (pageSizeRaw) {
      const n = Number(pageSizeRaw);
      // Require a real integer — a fractional value like 2.5 would otherwise be
      // forwarded to Google's maxResults verbatim.
      if (!Number.isInteger(n)) {
        throw new ValidationError("pageSize must be an integer");
      }
      pageSize = Math.min(500, Math.max(1, n));
    }
    const result = await listUsers(tenant, { pageToken, pageSize });
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to list users";
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
