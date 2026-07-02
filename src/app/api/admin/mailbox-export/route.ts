import { NextRequest, NextResponse } from "next/server";
import { exportMailboxPage } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";

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
  try {
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
    });

    // Audit the start of an export only (the very first call — no pageToken and
    // no pendingIds continuation). A full mailbox dump is sensitive — record who
    // pulled whose mail — but auditing every page would bury the log.
    if (!pageToken && !pendingIds) {
      audit({
        action: "mailbox_export",
        tenantId: tenant?.id ?? null,
        tenantName: tenant?.name ?? null,
        params: { user, includeSpamTrash },
        outcome: "success",
      });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Mailbox export failed";
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
