import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { preflightTenantScopesCached } from "@/lib/preflight";
import { audit } from "@/lib/audit";
import { actorFromRequest } from "@/lib/session";

/**
 * GET /api/admin/preflight-scopes
 *
 * Verifies that every OAuth scope Open Admin uses is authorised in the
 * tenant's Domain-Wide Delegation config. Surfaces a per-scope result so the
 * operator can fix Admin Console without having to run a real operation and
 * watch it fail.
 *
 * Pure read — nothing is mutated and no real Workspace API calls are issued.
 * We only ask Google's OAuth server for tokens.
 */
export async function GET(request: NextRequest) {
  const actor = await actorFromRequest(request);
  let tenant = null;
  try {
    // Resolve inside the try: a stale/deleted tenantId makes resolveTenant
    // throw, and we want that as this route's JSON error, not an unhandled 500.
    tenant = tenantFromRequest(request);
    if (!tenant) {
      return NextResponse.json(
        { success: false, error: "No tenant resolved — pass tenantId or activate one first" },
        { status: 400 }
      );
    }

    // `fresh=1` / `fresh=true` (the "Re-check" button) skips the short
    // per-tenant cache so the operator can confirm an Admin Console fix.
    const freshParam = request.nextUrl.searchParams.get("fresh");
    const fresh = freshParam === "1" || freshParam === "true";

    const { result, cached } = await preflightTenantScopesCached(tenant, {
      fresh,
    });
    const failing = result.results.filter((r) => !r.authorized).length;
    // Only log when tokens were actually exchanged: auditing a cache hit would
    // claim a DWD check against Google that never happened.
    if (!cached) {
      audit({
        action: "tenant.preflight_scopes",
        tenantId: tenant.id,
        tenantName: tenant.name,
        params: {
          scopeCount: result.results.length,
          failingScopes: failing,
          missingScopes: result.results
            .filter((r) => !r.authorized)
            .map((r) => r.scope),
        },
        outcome: failing > 0 ? "error" : "success",
        error: failing > 0 ? `${failing} of ${result.results.length} scopes not authorized` : undefined,
        actor,
      });
    }
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Preflight failed";
    audit({
      action: "tenant.preflight_scopes",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {},
      outcome: "error",
      error: message,
      actor,
    });
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
