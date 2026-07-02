import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { preflightTenantScopes } from "@/lib/preflight";
import { audit } from "@/lib/audit";

/**
 * GET /api/admin/preflight-scopes
 *
 * Verifies that every OAuth scope this toolbox uses is authorised in the
 * tenant's Domain-Wide Delegation config. Surfaces a per-scope result so the
 * operator can fix Admin Console without having to run a real operation and
 * watch it fail.
 *
 * Pure read — nothing is mutated and no real Workspace API calls are issued.
 * We only ask Google's OAuth server for tokens.
 */
export async function GET(request: NextRequest) {
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

    const result = await preflightTenantScopes(tenant);
    const failing = result.results.filter((r) => !r.authorized).length;
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
    });
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
    });
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
