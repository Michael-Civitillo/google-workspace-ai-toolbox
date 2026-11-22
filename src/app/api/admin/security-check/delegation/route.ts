import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { tenantFromRequest } from "@/lib/gws";
import { listDelegationChanges, serviceAccountClientId } from "@/lib/admin-sdk";
import { usedScopes } from "@/lib/preflight";
import {
  DELEGATION_WINDOW_DAYS,
  summariseDelegation,
  type DelegationReport,
} from "@/lib/security-check";
import { errorResponse } from "@/lib/api-errors";

/**
 * Security Check: domain-wide delegation, as far as the admin log shows it.
 *
 * GET /api/admin/security-check/delegation
 *
 * Read-only against Google, and it writes nothing locally. Returns one entry
 * per API client whose delegation was granted, changed or removed in the last
 * six months, newest state first. It is not the delegation list itself (Google
 * exposes that only in the Admin console), and the page says so.
 *
 * Tenant-wide rather than per account, so it is one call, separate from the
 * paged account scan.
 */
export async function GET(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  try {
    const tenant = tenantFromRequest(request);
    const { events, truncated } = await listDelegationChanges(tenant, {
      signal: request.signal,
    });
    const report: DelegationReport = {
      windowDays: DELEGATION_WINDOW_DAYS,
      clients: summariseDelegation(events, {
        ownClientId: serviceAccountClientId(tenant),
        usedScopes: usedScopes(),
      }),
      truncated,
    };
    return NextResponse.json(
      { success: true, data: report },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    return errorResponse(e, "Could not read domain-wide delegation changes");
  }
}
