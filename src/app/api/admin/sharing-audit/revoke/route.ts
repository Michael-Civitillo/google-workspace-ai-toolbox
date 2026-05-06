import { NextRequest, NextResponse } from "next/server";
import { revokeExternalPermissions } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";

/**
 * Strip every external permission from each requested file.
 *
 * POST /api/admin/sharing-audit/revoke
 * Body: { user: "alice@yourdomain.com", fileIds: ["abc...", ...] }
 *
 * Per-permission classification is re-evaluated server-side against the live
 * verified-domain set, so a stale client cannot trick this into removing
 * internal collaborators. Per-file outcomes are returned individually — one
 * file's failure never aborts the rest of the batch.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {}

  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");
    const rawFileIds = body.fileIds;
    if (!Array.isArray(rawFileIds) || rawFileIds.length === 0) {
      throw new ValidationError("fileIds must be a non-empty array");
    }
    const fileIds: string[] = [];
    for (const f of rawFileIds) {
      if (typeof f !== "string") {
        throw new ValidationError("Every fileId must be a string");
      }
      const trimmed = f.trim();
      // Drive file IDs are short alphanumeric tokens — reject anything weird
      // before sending it on to Google.
      if (!/^[A-Za-z0-9_-]{8,256}$/.test(trimmed)) {
        throw new ValidationError(`fileId ${JSON.stringify(f)} looks invalid`);
      }
      fileIds.push(trimmed);
    }

    const result = await revokeExternalPermissions(tenant, user, fileIds);

    const totalRemoved = result.results.reduce(
      (sum, r) => sum + r.removed,
      0
    );
    const filesWithErrors = result.results.filter(
      (r) => r.errors.length > 0
    ).length;

    audit({
      action: "sharing_audit.revoke",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {
        user,
        fileCount: fileIds.length,
        totalRemoved,
        filesWithErrors,
      },
      outcome: filesWithErrors > 0 ? "error" : "success",
      error:
        filesWithErrors > 0
          ? `${filesWithErrors} of ${fileIds.length} files had permission deletion errors`
          : undefined,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Revoke failed";
    audit({
      action: "sharing_audit.revoke",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: body,
      outcome: "error",
      error: message,
    });
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
