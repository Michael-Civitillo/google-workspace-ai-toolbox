import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { tenantFromRequest } from "@/lib/gws";
import { probeUnneededScopes } from "@/lib/preflight";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api-errors";
import { actorFromRequest } from "@/lib/session";

/**
 * Security Check: is Open Admin's own key authorised for more than it uses?
 *
 * POST /api/admin/security-check/own-key
 *
 * Asks Google for a token for each of a short list of broad scopes the app
 * never requests, and reports which ones Google was willing to grant. Nothing
 * is read or changed with those tokens; they are discarded.
 *
 * A POST, and audited, because it is not free of side effects: every request
 * is a token grant Google records against this service account. The page
 * runs it only when the operator asks.
 */
export async function POST(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  const actor = await actorFromRequest(request);
  let tenant = null;
  try {
    tenant = tenantFromRequest(request);
    if (!tenant) {
      return NextResponse.json(
        { success: false, error: "No tenant resolved — add or activate one first" },
        { status: 400 }
      );
    }
    const result = await probeUnneededScopes(tenant);
    const granted = result.probes.filter((p) => p.granted === true).map((p) => p.scope);
    audit({
      action: "security_check.own_key_test",
      tenantId: tenant.id,
      tenantName: tenant.name,
      params: { scopesTested: result.probes.length, unneededScopesGranted: granted },
      outcome: "success",
      actor,
    });
    return NextResponse.json(
      { success: true, data: result },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    audit({
      action: "security_check.own_key_test",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {},
      outcome: "error",
      error: e instanceof Error ? e.message : String(e),
      actor,
    });
    return errorResponse(e, "Could not test the key");
  }
}
