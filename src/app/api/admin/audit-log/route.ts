import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import {
  decodeAuditCursor,
  encodeAuditCursor,
  readAuditLogPage,
  type AuditCursor,
  type AuditLogFilters,
} from "@/lib/audit-reader";
import { ValidationError } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";

/**
 * Read-only, paginated access to the append-only audit log: the live file and
 * its rotated archives, newest first.
 *
 * GET /api/admin/audit-log?[cursor=...][&limit=200][&action=...][&outcome=...]
 *       [&tenantId=...][&from=ISO][&to=ISO]
 *
 * `cursor` is the opaque `nextCursor` of the previous page. It names the file
 * it points into, so a rotation between two calls cannot mix files up; when
 * that file is gone the answer starts again from the newest entry and says
 * `restarted: true`.
 *
 * Deliberately does NOT resolve a tenant: the log is a cross-tenant record
 * and no Google API is touched. Session auth is enforced by the middleware
 * like every other route; `tenantId` here is just a filter on the entries.
 */

function intParam(
  raw: string | null,
  field: string,
  opts: { min: number; max: number; fallback: number }
): number {
  if (raw === null || raw === "") return opts.fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ValidationError(`${field} must be an integer`);
  }
  return Math.min(opts.max, Math.max(opts.min, n));
}

function dateParamMs(raw: string | null, field: string): number | undefined {
  if (raw === null || raw === "") return undefined;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new ValidationError(`${field} must be a valid date`);
  }
  return ms;
}

export async function GET(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  try {
    const params = request.nextUrl.searchParams;

    const cursorRaw = params.get("cursor");
    let cursor: AuditCursor | null = null;
    if (cursorRaw !== null && cursorRaw !== "") {
      cursor = decodeAuditCursor(cursorRaw);
      if (!cursor) {
        throw new ValidationError(
          "cursor is malformed — start the search again"
        );
      }
    }

    const limit = intParam(params.get("limit"), "limit", {
      min: 1,
      max: 500,
      fallback: 200,
    });

    const outcomeRaw = params.get("outcome");
    let outcome: AuditLogFilters["outcome"];
    if (outcomeRaw) {
      if (outcomeRaw !== "success" && outcomeRaw !== "error") {
        throw new ValidationError('outcome must be "success" or "error"');
      }
      outcome = outcomeRaw;
    }

    const fromMs = dateParamMs(params.get("from"), "from");
    const toMs = dateParamMs(params.get("to"), "to");

    const filters: AuditLogFilters = {
      action: params.get("action")?.slice(0, 200) || undefined,
      outcome,
      tenantId: params.get("tenantId") || undefined,
      fromMs,
      toMs,
    };

    const page = await readAuditLogPage({
      cursor,
      maxEntries: limit,
      filters,
    });

    return NextResponse.json({
      success: true,
      data: {
        entries: page.entries,
        nextCursor: page.nextCursor ? encodeAuditCursor(page.nextCursor) : null,
        scannedBytes: page.scannedBytes,
        skippedLines: page.skippedLines,
        done: page.done,
        reachedFromBound: page.reachedFromBound,
        oldestScannedTs: page.oldestScannedTs,
        restarted: page.restarted,
      },
    });
  } catch (e) {
    return errorResponse(e, "Failed to read the audit log");
  }
}
