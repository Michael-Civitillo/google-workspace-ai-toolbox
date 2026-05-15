import { NextRequest, NextResponse } from "next/server";
import { revokeExternalPermissions, type RevokeCategory } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";

const VALID_CATEGORIES: ReadonlySet<RevokeCategory> = new Set([
  "anyone",
  "domain",
  "user",
  "group",
]);

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

    let categories: RevokeCategory[] | undefined;
    if (body.categories !== undefined) {
      if (!Array.isArray(body.categories) || body.categories.length === 0) {
        // Empty list would silently no-op and audit as success — refuse it so
        // the operator can't accidentally run a meaningless revoke.
        throw new ValidationError(
          "categories must be a non-empty array of permission types"
        );
      }
      const parsed: RevokeCategory[] = [];
      for (const c of body.categories) {
        if (typeof c !== "string" || !VALID_CATEGORIES.has(c as RevokeCategory)) {
          throw new ValidationError(
            `Invalid category ${JSON.stringify(c)} — must be one of anyone, domain, user, group`
          );
        }
        parsed.push(c as RevokeCategory);
      }
      categories = parsed;
    }

    const result = await revokeExternalPermissions(tenant, user, fileIds, {
      categories,
    });

    const totalRemoved = result.results.reduce(
      (sum, r) => sum + r.removed,
      0
    );
    const filesWithErrors = result.results.filter(
      (r) => r.errors.length > 0
    ).length;

    // Capture the actual Drive API error per permission so the audit log
    // alone is enough to diagnose why a revoke failed. Capped at 50 file
    // entries to keep the log line from blowing up on huge batches; the
    // browser response still carries the full set.
    const FAILURE_DETAIL_CAP = 50;
    const failures = result.results
      .filter((r) => r.errors.length > 0)
      .slice(0, FAILURE_DETAIL_CAP)
      .map((r) => ({
        fileId: r.fileId,
        fileName: r.fileName ?? null,
        errors: r.errors,
      }));

    audit({
      action: "sharing_audit.revoke",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {
        user,
        fileCount: fileIds.length,
        totalRemoved,
        filesWithErrors,
        categories: categories ?? null,
        ...(failures.length > 0 ? { failures } : {}),
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
