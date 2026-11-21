import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { parseSnapshot } from "@/lib/security-check";
import { readLastScan, saveLastScan } from "@/lib/security-history";
import { ValidationError } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * Security Check: the previous finished scan, for "what's new since last time".
 *
 * GET  /api/admin/security-check/history   -> the last snapshot, or null
 * POST /api/admin/security-check/history   { completedAt, keys, covered }
 *
 * Purely local: nothing here talks to Google. The page reads the baseline
 * before a scan and stores the new one after a scan that finished.
 */
const MAX_BODY_BYTES = 24 * 1024 * 1024;

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    return NextResponse.json(
      { success: true, data: readLastScan(tenant?.id ?? null) },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    return errorResponse(e, "Could not read the previous scan");
  }
}

export async function POST(request: NextRequest) {
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }
  try {
    const tenant = tenantFromRequest(request, body);
    const snapshot = parseSnapshot(body);
    if (!snapshot) throw new ValidationError("That is not a scan snapshot");
    // The server stamps the time: a remembered scan is dated when it was
    // saved here, not when a browser clock says it finished.
    await saveLastScan(tenant?.id ?? null, {
      ...snapshot,
      completedAt: new Date().toISOString(),
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    return errorResponse(e, "Could not save the scan");
  }
}
