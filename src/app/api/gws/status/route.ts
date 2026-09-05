import { NextRequest, NextResponse } from "next/server";
import { checkGwsStatus } from "@/lib/gws";

export async function GET(request: NextRequest) {
  // `?fresh=1` (the Re-check buttons) bypasses the short status cache.
  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  const status = await checkGwsStatus({ fresh });
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}
