import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { listExternallySharedDriveFiles } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";

/**
 * Sharing audit: files in one shared drive that are shared outside the
 * organisation on top of the drive's membership.
 *
 * GET /api/admin/sharing-audit/shared-drives/files
 *       ?driveId=...&as=member1@yourdomain.com,member2@...[&pageToken=...]
 *
 * Read-only, Drive metadata only. `as` lists internal members of the drive
 * (from the drives listing); the scan runs as the first who can read it and
 * reports which in `user`. A continuation passes that one user back, because
 * Drive's page tokens belong to whoever was issued them. Capped per request
 * like the per-user scan; `nextPageToken` continues.
 */
const MAX_AS = 5;

export async function GET(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  try {
    const tenant = tenantFromRequest(request);
    const params = request.nextUrl.searchParams;

    const driveId = params.get("driveId")?.trim() ?? "";
    if (!driveId) throw new ValidationError("driveId is required");

    const asUsers = (params.get("as") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (asUsers.length === 0) {
      throw new ValidationError("as must name at least one member of the drive");
    }
    if (asUsers.length > MAX_AS) {
      throw new ValidationError(`as may name at most ${MAX_AS} members`);
    }
    const members = asUsers.map((u) => requireEmail(u, "as"));

    const rawPageToken = params.get("pageToken");
    let pageToken: string | undefined;
    if (rawPageToken !== null) {
      if (rawPageToken.length === 0 || rawPageToken.length > 4096) {
        throw new ValidationError("pageToken is malformed");
      }
      pageToken = rawPageToken;
    }

    const result = await listExternallySharedDriveFiles(tenant, {
      driveId,
      asUsers: members,
      pageToken,
      signal: request.signal,
    });
    return NextResponse.json(
      { success: true, data: result },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    return errorResponse(e, "Could not scan the shared drive");
  }
}
