import { NextRequest, NextResponse } from "next/server";
import { checkGwsStatus } from "@/lib/gws";

export async function GET(request: NextRequest) {
  // `?fresh=1` (the Re-check buttons) bypasses the short status cache.
  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  const status = await checkGwsStatus({ fresh });
  // The packaged desktop build bundles its own runtime and talks to Google
  // through the googleapis SDK, so a missing gws CLI is a non-event there.
  // The UI reads this to show "Optional" instead of a red "Missing".
  const packaged = process.env.OPEN_ADMIN_PACKAGED === "1";
  return NextResponse.json(
    { ...status, packaged, required: !packaged },
    { headers: { "cache-control": "no-store" } }
  );
}
