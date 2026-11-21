import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { listDomains } from "@/lib/admin-sdk";
import { makeTxtLookup } from "@/lib/dns-txt";
import {
  checkDomainEmailAuth,
  compareDomains,
  type EmailAuthReport,
} from "@/lib/email-auth";
import { errorResponse } from "@/lib/api-errors";

/**
 * Security Check: do the tenant's domains publish SPF, DKIM and DMARC?
 *
 * GET /api/admin/security-check/email-auth
 *
 * Asks Google only which domains the tenant has verified; everything else is
 * public DNS, so this needs no permission beyond the domain listing the app
 * already does. Read-only, and writes nothing locally. Tenant-wide, so it is
 * one call beside the paged account scan.
 */

// Far more than a tenant has; a bound so a strange directory can't turn one
// request into thousands of lookups.
const MAX_DOMAINS = 100;

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const domains = (await listDomains(tenant))
      .filter((d) => d.verified)
      .slice(0, MAX_DOMAINS);
    const lookup = makeTxtLookup();
    const report: EmailAuthReport = {
      domains: (
        await Promise.all(domains.map((d) => checkDomainEmailAuth(d, lookup)))
      ).sort(compareDomains),
    };
    return NextResponse.json(
      { success: true, data: report },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    return errorResponse(e, "Could not check email authentication");
  }
}
