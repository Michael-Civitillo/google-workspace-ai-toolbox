import { NextRequest, NextResponse } from "next/server";
import { listDomains } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const domains = await listDomains(tenant);
    return NextResponse.json({ success: true, data: domains });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list domains";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
