import { NextRequest, NextResponse } from "next/server";
import { resolveFilePaths, PATH_RESOLVE_FILE_CAP } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * Resolve each requested file ID to its full Drive folder path so a CSV
 * export of an external-sharing audit can show "where the file lives" next
 * to "what's wrong with it". Read-only; no Drive content is touched.
 *
 * POST /api/admin/sharing-audit/resolve-paths
 * Body: { user, fileIds[] }
 * Returns: { paths: { [fileId]: string } }
 */
// The body is a user email plus an array of Drive file IDs (resolve caps the
// batch at 1,000 files; each id is <=256 chars). 1 MB leaves generous headroom
// while still rejecting an oversized payload up front.
const MAX_BODY_BYTES = 1 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }

  try {
    const tenant = tenantFromRequest(request, body);
    const user = requireEmail(body.user, "user");
    const rawFileIds = body.fileIds;
    if (!Array.isArray(rawFileIds) || rawFileIds.length === 0) {
      throw new ValidationError("fileIds must be a non-empty array");
    }
    // Mirror the library cap here so an oversized batch is a 400 with a clear
    // message rather than a 500 from the resolver (the revoke route does the
    // same for its own cap).
    if (rawFileIds.length > PATH_RESOLVE_FILE_CAP) {
      throw new ValidationError(
        `Too many files in one resolve batch — cap is ${PATH_RESOLVE_FILE_CAP}`
      );
    }
    const fileIds: string[] = [];
    for (const f of rawFileIds) {
      if (typeof f !== "string") {
        throw new ValidationError("Every fileId must be a string");
      }
      const trimmed = f.trim();
      // Same Drive file-ID shape check used elsewhere.
      if (!/^[A-Za-z0-9_-]{8,256}$/.test(trimmed)) {
        throw new ValidationError(`fileId ${JSON.stringify(f)} looks invalid`);
      }
      fileIds.push(trimmed);
    }

    const paths = await resolveFilePaths(tenant, user, fileIds);
    return NextResponse.json({ success: true, data: { paths } });
  } catch (e) {
    return errorResponse(e, "Path resolve failed");
  }
}
