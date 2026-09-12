import { NextRequest, NextResponse } from "next/server";
import { revokeExternalPermissions, type RevokeCategory } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit, boundedParams } from "@/lib/audit";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";
import { actorFromRequest } from "@/lib/session";

const VALID_CATEGORIES: ReadonlySet<RevokeCategory> = new Set([
  "anyone",
  "domain",
  "user",
  "group",
]);

// The body is a user email plus an array of Drive file IDs (revoke caps the
// batch at 200 files; each id is <=256 chars). 1 MB leaves generous headroom
// while still rejecting an oversized payload before it reaches audit.log.
const MAX_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Strip every external permission from each requested file.
 *
 * POST /api/admin/sharing-audit/revoke
 * Body: { user: "alice@yourdomain.com", fileIds: ["abc...", ...] }
 *
 * A batch touching more than one file also requires `confirm: "REVOKE"` — the
 * browser gates bulk un-sharing behind that typed phrase, and un-sharing can't
 * be undone from here, so the API must demand it too.
 *
 * Per-permission classification is re-evaluated server-side against the live
 * verified-domain set, so a stale client cannot trick this into removing
 * internal collaborators. Per-file outcomes are returned individually — one
 * file's failure never aborts the rest of the batch.
 */
export async function POST(request: NextRequest) {
  const actor = await actorFromRequest(request);
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }

  let tenant = null;
  try {
    tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");
    const rawFileIds = body.fileIds;
    if (!Array.isArray(rawFileIds) || rawFileIds.length === 0) {
      throw new ValidationError("fileIds must be a non-empty array");
    }
    // Mirror admin-sdk's REVOKE_FILE_CAP here so an oversized batch is a 400
    // (client error) rather than surfacing as a generic 500 from the throw
    // inside revokeExternalPermissions.
    if (rawFileIds.length > 200) {
      throw new ValidationError(
        "Too many files in one revoke batch — cap is 200"
      );
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

    // Bulk un-sharing can't be reversed from this tool, and a session cookie is
    // all the API itself demands — so re-check the phrase the UI already types.
    // One file stays unconfirmed so the per-row revoke buttons keep working.
    if (fileIds.length > 1) {
      const confirm =
        typeof body.confirm === "string" ? body.confirm.trim() : "";
      if (confirm !== "REVOKE") {
        throw new ValidationError(
          "Type REVOKE into the confirm field to revoke sharing on multiple files at once."
        );
      }
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
      // Without this the batch keeps deleting permissions after the operator
      // cancels (or a proxy hangs up), on the tenant's Drive quota and with
      // nobody left to read which files were touched.
      signal: request.signal,
    });

    const totalRemoved = result.results.reduce(
      (sum, r) => sum + r.removed,
      0
    );
    const totalRemovedAsAdmin = result.results.reduce(
      (sum, r) => sum + (r.removedAsAdmin ?? 0),
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

    // Files where revoke completed cleanly but had nothing to do: no perms
    // matched the classifier (audit snapshot was probably stale — perms got
    // cleaned between the audit and now), or no perms matched the category
    // filter. Logged so a "removed 0 from 56 files" outcome is diagnosable.
    const noOps = result.results
      .filter(
        (r) =>
          r.removed === 0 &&
          r.errors.length === 0 &&
          !r.notFound
      )
      .slice(0, FAILURE_DETAIL_CAP)
      .map((r) => ({
        fileId: r.fileId,
        fileName: r.fileName ?? null,
        permissionsSeen: r.permissionsSeen ?? 0,
        permissionsTargeted: r.permissionsTargeted ?? 0,
      }));
    const noOpFileCount = result.results.filter(
      (r) =>
        r.removed === 0 && r.errors.length === 0 && !r.notFound
    ).length;

    audit({
      action: "sharing_audit.revoke",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {
        user,
        fileCount: fileIds.length,
        // Cut short by the caller: only these files were processed, so the
        // counters below describe a partial batch, not the whole request.
        ...(result.aborted
          ? { aborted: true, filesProcessed: result.results.length }
          : {}),
        totalRemoved,
        totalRemovedAsAdmin,
        filesWithErrors,
        noOpFileCount,
        categories: categories ?? null,
        ...(failures.length > 0 ? { failures } : {}),
        ...(noOps.length > 0 ? { noOps } : {}),
      },
      actor,
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
      params: boundedParams(body),
      actor,
      outcome: "error",
      error: message,
    });
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
