import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { listDirectoryAccounts } from "@/lib/admin-sdk";
import { ValidationError } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";

/**
 * One page of the directory, with each account's state: suspended, archived,
 * whether it has a mailbox, and when it was last signed in to.
 *
 * GET /api/admin/accounts?pageToken=<token>
 *
 * Read-only. The Licences page sets it next to the licence list; Signatures
 * uses it to fill in "everyone with a mailbox".
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
