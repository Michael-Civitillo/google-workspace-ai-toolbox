import { NextRequest, NextResponse } from "next/server";
import { readAuditLogPage, type AuditLogFilters } from "@/lib/audit-reader";
import { ValidationError } from "@/lib/validate";

/**
 * Read-only, paginated access to the append-only audit log.
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
  try {
    const params = request.nextUrl.searchParams;

    const cursorRaw = params.get("cursor");
    let cursor: number | null = null;
    if (cursorRaw !== null && cursorRaw !== "") {
      const n = Number(cursorRaw);
      if (!Number.isInteger(n) || n < 0) {
        throw new ValidationError("cursor must be a non-negative integer");
      }
      cursor = n;
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
        nextCursor: page.nextCursor,
        scannedBytes: page.scannedBytes,
        skippedLines: page.skippedLines,
        done: page.done,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  const message = e instanceof Error ? e.message : "Unexpected error";
  const status = e instanceof ValidationError ? 400 : 500;
  return NextResponse.json({ success: false, error: message }, { status });
}
