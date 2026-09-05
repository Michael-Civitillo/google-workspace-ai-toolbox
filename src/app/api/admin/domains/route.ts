import { NextRequest, NextResponse } from "next/server";
import { listDomains } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { errorResponse } from "@/lib/api-errors";

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const domains = await listDomains(tenant);
    return NextResponse.json({ success: true, data: domains });
  } catch (error) {
    // A stale tenant id is 404 and a Google rejection 502, not a blanket 500.
    return errorResponse(error, "Failed to list domains");
  }
}
