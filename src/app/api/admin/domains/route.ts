import { NextResponse } from "next/server";
import { listDomains } from "@/lib/admin-sdk";

/**
 * List all domains in the tenant.
 * GET /api/admin/domains
 */
export async function GET() {
  try {
    const domains = await listDomains();
    return NextResponse.json({ success: true, data: domains });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list domains";
    return NextResponse.json({ success: false, error: message });
  }
}
