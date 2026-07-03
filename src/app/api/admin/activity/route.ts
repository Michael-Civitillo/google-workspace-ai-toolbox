import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { listActivityEvents } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";

/**
 * Sign-in and admin-console activity from the Reports API (read-only).
 * `app=login` → sign-in events; `app=admin` → Admin Console actions.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const params = request.nextUrl.searchParams;

    const app = params.get("app");
    if (app !== "login" && app !== "admin") {
      throw new ValidationError('app must be "login" or "admin"');
    }

    const userRaw = params.get("user");
    const userKey = userRaw ? requireEmail(userRaw, "user") : undefined;

    const daysRaw = params.get("days");
    let days = 7;
    if (daysRaw !== null && daysRaw !== "") {
      const n = Number(daysRaw);
      if (!Number.isInteger(n)) {
        throw new ValidationError("days must be an integer");
      }
      days = Math.min(180, Math.max(1, n));
    }
    const startTime = new Date(Date.now() - days * 86_400_000).toISOString();

    const pageSizeRaw = params.get("pageSize");
    let maxResults: number | undefined;
    if (pageSizeRaw !== null && pageSizeRaw !== "") {
      const n = Number(pageSizeRaw);
      if (!Number.isInteger(n)) {
        throw new ValidationError("pageSize must be an integer");
      }
      maxResults = Math.min(1000, Math.max(1, n));
    }

    const result = await listActivityEvents(tenant, {
      app,
      userKey,
      startTime,
      pageToken: params.get("pageToken") || undefined,
      maxResults,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  const message = e instanceof Error ? e.message : "Unexpected error";
  const status = e instanceof ValidationError ? 400 : 500;
  return NextResponse.json({ success: false, error: message }, { status });
}
