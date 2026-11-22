import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { tenantFromRequest } from "@/lib/gws";
import {
  listDomains,
  scanSecurityPage,
  SECURITY_CHECK_MAX_PAGE,
} from "@/lib/admin-sdk";
import { ValidationError } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";

/**
 * Security Check: one page of the tenant-wide scan.
 *
 * GET /api/admin/security-check[?pageToken=...][&pageSize=50]
 *
 * Read-only against Google, and it writes nothing locally. Each call checks
 * one page of accounts for the four things the page reports: no 2-Step
 * Verification, no sign-in for a long time, mail forwarded outside the
 * organisation, and outside apps holding access. The client chains calls on
 * `nextPageToken` until it is null, adding the pages up as it goes.
 */
export async function GET(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  try {
    const tenant = tenantFromRequest(request);
    const params = request.nextUrl.searchParams;

    const rawPageToken = params.get("pageToken");
    let pageToken: string | undefined;
    if (rawPageToken !== null) {
      if (rawPageToken.length === 0 || rawPageToken.length > 4096) {
        throw new ValidationError("pageToken is malformed");
      }
      pageToken = rawPageToken;
    }

    const pageSizeRaw = params.get("pageSize");
    let pageSize: number | undefined;
    if (pageSizeRaw) {
      const n = Number(pageSizeRaw);
      if (!Number.isInteger(n)) {
        throw new ValidationError("pageSize must be an integer");
      }
      pageSize = Math.min(SECURITY_CHECK_MAX_PAGE, Math.max(1, n));
    }

    // What counts as "outside the organisation". Deliberately not caught: if
    // the domains cannot be listed there is no honest way to say which
    // forwards are external, and guessing either way would be worse than an
    // error the operator can see.
    const verifiedDomains = new Set(
      (await listDomains(tenant))
        .filter((d) => d.verified)
        .map((d) => d.domainName)
    );
    if (verifiedDomains.size === 0) {
      throw new Error(
        "Google returned no verified domains for this tenant, so forwarding " +
          "can't be classified as internal or external."
      );
    }

    const page = await scanSecurityPage(tenant, {
      verifiedDomains,
      pageToken,
      pageSize,
      signal: request.signal,
    });

    return NextResponse.json(
      { success: true, data: page },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    return errorResponse(e, "Security check failed");
  }
}
