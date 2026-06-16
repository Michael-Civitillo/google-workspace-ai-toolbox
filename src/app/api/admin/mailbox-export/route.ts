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
 * Capped server-side at 50 messages per request so a page of large messages
 * can't blow the response size. The client chains `nextPageToken` to walk the
 * rest of the mailbox.
 */
export async function GET(request: NextRequest) {
  const tenant = tenantFromRequest(request);
  try {
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
      if (!Number.isFinite(pageSize)) {
        throw new ValidationError("pageSize must be a number");
      }
    }

    const includeSpamTrash =
      request.nextUrl.searchParams.get("includeSpamTrash") === "true";

    const result = await exportMailboxPage(tenant, user, {
      pageToken,
      pageSize,
      includeSpamTrash,
    });

    // Audit the start of an export only (the first page). A full mailbox dump
    // is sensitive — record who pulled whose mail — but auditing every page
    // would bury the log without adding signal.
    if (!pageToken) {
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
