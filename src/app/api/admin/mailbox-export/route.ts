import { NextRequest, NextResponse } from "next/server";
import { exportMailboxPage, isAbortError } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";
import { actorFromRequest } from "@/lib/session";
import { acquireSlot, BusyError } from "@/lib/concurrency";
import { errorStatusFor } from "@/lib/api-errors";

// When each (tenant, operator, mailbox) export was last written to the audit
// log. The log records who read whose mail, decided here rather than by the
// caller saying "this is the first page": a page with a token still reads
// mail. Once per half hour keeps a long export to one entry.
const EXPORT_AUDIT_WINDOW_MS = 30 * 60_000;
const EXPORT_AUDIT_MAX_KEYS = 1000;
const g = globalThis as typeof globalThis & {
  __openAdminExportAudited?: Map<string, number>;
};
const exportAudited = (g.__openAdminExportAudited ??= new Map<string, number>());

/** True when this export has not been logged in the last half hour, and marks it logged. */
function claimExportAudit(key: string, now = Date.now()): boolean {
  const last = exportAudited.get(key);
  if (last !== undefined && now - last < EXPORT_AUDIT_WINDOW_MS) return false;
  if (exportAudited.size >= EXPORT_AUDIT_MAX_KEYS) {
    for (const [k, at] of exportAudited) {
      if (now - at >= EXPORT_AUDIT_WINDOW_MS) exportAudited.delete(k);
    }
    // Still full: drop the oldest, so the newest export is always logged.
    if (exportAudited.size >= EXPORT_AUDIT_MAX_KEYS) {
      const oldest = exportAudited.keys().next().value;
      if (oldest !== undefined) exportAudited.delete(oldest);
    }
  }
  exportAudited.delete(key);
  exportAudited.set(key, now);
  return true;
}

/**
 * Export one page of a user's mailbox for backup.
 *
 * GET /api/admin/mailbox-export?user=alice@yourdomain.com&pageToken=...&pageSize=25&includeSpamTrash=true
 *
 * Read-only. Returns each message as its raw RFC 822 MIME blob (base64url)
 * plus its labels and internal date, so the client can stream a whole mailbox
 * to disk page by page. The first page (no pageToken) also carries the
 * mailbox's label set for the export header.
 *
 * Defaults to 25 messages per request and is capped server-side at 50 so a
 * page of large messages can't blow the response size. The client chains
 * `nextPageToken` to walk the rest of the mailbox.
 */
export async function GET(request: NextRequest) {
  // Resolved before the try so the error path can attribute the failure too.
  const actor = await actorFromRequest(request);

  let release: (() => void) | null = null;
  try {
    // A page holds up to 16 MiB of raw base64 message data and serialising the
    // response roughly doubles that, so a couple of parallel exports can own a
    // small host's heap. 2 because the export client walks pages strictly
    // sequentially — one operator never trips it — and it still leaves room for
    // a second operator or a retry issued right after a cancel.
    release = acquireSlot("mailbox-export", 2, "mailbox export");

    // Resolve inside the try: a stale/deleted tenantId makes resolveTenant throw,
    // and we want that surfaced as the route's JSON error shape (not an
    // unhandled non-JSON 500 the client reports as "failed to connect").
    const tenant = tenantFromRequest(request);
    const user = requireEmail(request.nextUrl.searchParams.get("user"), "user");

    const rawPageToken = request.nextUrl.searchParams.get("pageToken");
    let pageToken: string | undefined;
    if (rawPageToken !== null) {
      if (rawPageToken.length === 0 || rawPageToken.length > 4096) {
        throw new ValidationError("pageToken is malformed");
      }
      pageToken = rawPageToken;
    }

    const pageSizeRaw = request.nextUrl.searchParams.get("pageSize");
    let pageSize: number | undefined;
    if (pageSizeRaw !== null) {
      pageSize = Number(pageSizeRaw);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
        throw new ValidationError(
          "pageSize must be an integer between 1 and 50"
        );
      }
    }

    const includeSpamTrash =
      request.nextUrl.searchParams.get("includeSpamTrash") === "true";

    // Continuation of a list page whose byte budget was hit: the client sends
    // back the unfetched message ids (comma-joined). Validate shape and bound
    // the count so a caller can't push an unbounded id list into memory.
    const rawPendingIds = request.nextUrl.searchParams.get("pendingIds");
    let pendingIds: string[] | undefined;
    if (rawPendingIds) {
      const parts = rawPendingIds.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 50) {
        throw new ValidationError("pendingIds exceeds the per-page limit");
      }
      for (const id of parts) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
          throw new ValidationError("pendingIds contains a malformed id");
        }
      }
      if (parts.length > 0) pendingIds = parts;
    }

    const result = await exportMailboxPage(tenant, user, {
      pageToken,
      pageSize,
      includeSpamTrash,
      pendingIds,
      // Without this the page keeps fetching up to 50 raw messages after the
      // operator cancels (or a proxy hangs up), spending Gmail quota and heap
      // on a response nobody will read.
      signal: request.signal,
    });

    // A full mailbox dump is sensitive — record who pulled whose mail — but
    // auditing every page would bury the log: once per export, as decided
    // above, whichever page it starts from.
    if (claimExportAudit(`${tenant?.id ?? ""}|${actor}|${user}`)) {
      audit({
        action: "mailbox_export",
        tenantId: tenant?.id ?? null,
        tenantName: tenant?.name ?? null,
        params: {
          user,
          includeSpamTrash,
          // Started from a page other than the first (a resumed export).
          ...(pageToken || pendingIds ? { continued: true } : {}),
          // The caller went away mid-page: some mail was still read, so the
          // entry stays, flagged as cut short rather than as a clean export.
          ...(result.aborted ? { aborted: true } : {}),
        },
        outcome: "success",
        actor,
      });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    if (e instanceof BusyError) {
      return NextResponse.json(
        { success: false, error: e.message },
        { status: 429 }
      );
    }
    // A cancelled request is not a server fault and must not read as a 500 in
    // monitoring: nothing upstream failed, the caller simply went away.
    if (isAbortError(e)) {
      return NextResponse.json(
        { success: false, error: "Request cancelled by the client" },
        { status: 499 }
      );
    }
    const message = e instanceof Error ? e.message : "Mailbox export failed";
    const status = errorStatusFor(e);
    return NextResponse.json({ success: false, error: message }, { status });
  } finally {
    release?.();
  }
}
