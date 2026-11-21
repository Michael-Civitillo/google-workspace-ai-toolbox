import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { listActivityEvents } from "@/lib/admin-sdk";
import { requireEmail, ValidationError } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";

const MAX_DAYS = 180;
const DAY_MS = 86_400_000;

/**
 * Sign-in and admin-console activity from the Reports API (read-only).
 * `app=login` → sign-in events; `app=admin` → Admin Console actions.
 *
 * GET /api/admin/activity?app=login[&user=...][&days=7 | &startTime=ISO]
 *       [&pageToken=...][&pageSize=100]
 *
 * The answer carries the `startTime` it used. A follow-up page must send that
 * back instead of `days`: a page token belongs to the query it came from, and
 * recomputing "7 days ago" a minute later asks Google for a different window.
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

    let startTime: string;
    const startRaw = params.get("startTime");
    if (startRaw !== null && startRaw !== "") {
      const ms = Date.parse(startRaw);
      if (Number.isNaN(ms)) {
        throw new ValidationError("startTime must be a valid date");
      }
      const now = Date.now();
      // A day of slack either way: the value was computed by this route a
      // little earlier, possibly on a clock that has drifted since.
      if (ms > now + DAY_MS || ms < now - (MAX_DAYS + 1) * DAY_MS) {
        throw new ValidationError(
          `startTime must be within the last ${MAX_DAYS} days`
        );
      }
      startTime = new Date(ms).toISOString();
    } else {
      const daysRaw = params.get("days");
      let days = 7;
      if (daysRaw !== null && daysRaw !== "") {
        const n = Number(daysRaw);
        if (!Number.isInteger(n)) {
          throw new ValidationError("days must be an integer");
        }
        days = Math.min(MAX_DAYS, Math.max(1, n));
      }
      startTime = new Date(Date.now() - days * DAY_MS).toISOString();
    }

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
    return NextResponse.json({ success: true, data: { ...result, startTime } });
  } catch (e) {
    return errorResponse(e, "Failed to load activity");
  }
}
