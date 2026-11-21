import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { listDirectoryAccounts } from "@/lib/admin-sdk";
import { ValidationError } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";

/**
 * One page of the directory, for the Licences page to set next to the licence
 * list: who is suspended, and who hasn't signed in for a long time.
 *
 * GET /api/admin/licenses/accounts?pageToken=<token>
 *
 * Read-only.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const pageToken = request.nextUrl.searchParams.get("pageToken") || undefined;
    if (pageToken && pageToken.length > 2048) {
      throw new ValidationError("pageToken is too long");
    }
    const page = await listDirectoryAccounts(tenant, {
      pageToken,
      signal: request.signal,
    });
    return NextResponse.json({ success: true, data: page });
  } catch (e) {
    return errorResponse(e);
  }
}
