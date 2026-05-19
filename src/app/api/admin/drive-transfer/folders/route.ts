import { NextRequest, NextResponse } from "next/server";
import { listDriveFolders } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{8,256}$/;

/**
 * List folders in a user's Drive for the folder-picker UI.
 *
 * GET /api/admin/drive-transfer/folders?user=alice@yourdomain.com&parent=<id>&pageToken=<token>
 *
 * When `parent` is omitted the listing returns the user's My Drive root
 * folders. Only folders owned by the user are returned — these are the ones
 * we can transfer. Read-only.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const user = requireEmail(request.nextUrl.searchParams.get("user"), "user");
    const rawParent = request.nextUrl.searchParams.get("parent");
    let parent: string | undefined;
    if (rawParent !== null) {
      const trimmed = rawParent.trim();
      if (trimmed !== "" && trimmed !== "root" && !DRIVE_ID_RE.test(trimmed)) {
        throw new ValidationError("parent folder id looks invalid");
      }
      parent = trimmed === "" ? undefined : trimmed;
    }
    const rawPageToken = request.nextUrl.searchParams.get("pageToken");
    let pageToken: string | undefined;
    if (rawPageToken !== null) {
      if (rawPageToken.length === 0 || rawPageToken.length > 4096) {
        throw new ValidationError("pageToken is malformed");
      }
      pageToken = rawPageToken;
    }

    const result = await listDriveFolders(tenant, user, parent, pageToken);
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Folder listing failed";
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
