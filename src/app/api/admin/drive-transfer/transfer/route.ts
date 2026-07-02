import { NextRequest, NextResponse } from "next/server";
import {
  buildInitialTransferCursor,
  sanitizeTransferCursor,
  transferDriveFoldersOwnership,
} from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

// The largest legitimate body is a continuation cursor: a queue capped at
// 20,000 ids (~90 chars each) ≈ 2 MB. 4 MB leaves headroom while still
// rejecting an unbounded payload before it's buffered and parsed.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Transfer ownership of the selected folders and everything inside them from
 * `fromUser` to `toUser`. Runs a bounded chunk per call — re-invoke with the
 * returned `cursor` until `nextCursor` is null.
 *
 * POST /api/admin/drive-transfer/transfer
 * Initial body:    { fromUser, toUser, folderIds: [<driveId>, ...] }
 * Continuation:    { fromUser, toUser, cursor: { queue, current } }
 *
 * Per-item failures are collected, never thrown — one bad file doesn't abort
 * the batch. Items not owned by `fromUser` are silently counted as skipped.
 */
export async function POST(request: NextRequest) {
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json(
      { success: false, error: "Body too large" },
      { status: 413 }
    );
  }

  let tenant = null;
  let fromUser: string | null = null;
  let toUser: string | null = null;
  try {
    tenant = tenantFromRequest(request, body);
    fromUser = requireEmail(body.fromUser, "fromUser");
    toUser = requireEmail(body.toUser, "toUser");
    if (fromUser === toUser) {
      throw new ValidationError("fromUser and toUser must be different");
    }

    const hasFolderIds = Array.isArray(body.folderIds) && body.folderIds.length > 0;
    const hasCursor = body.cursor !== undefined && body.cursor !== null;

    if (hasFolderIds && hasCursor) {
      throw new ValidationError(
        "Send either folderIds (initial call) or cursor (continuation) — not both"
      );
    }
    if (!hasFolderIds && !hasCursor) {
      throw new ValidationError(
        "Either folderIds (initial call) or cursor (continuation) is required"
      );
    }

    let cursor;
    let initialFolderCount = 0;
    if (hasFolderIds) {
      const rawIds = body.folderIds as unknown[];
      const ids: string[] = [];
      for (const r of rawIds) {
        if (typeof r !== "string") {
          throw new ValidationError("Every folderId must be a string");
        }
        ids.push(r.trim());
      }
      cursor = buildInitialTransferCursor(ids);
      initialFolderCount = ids.length;
    } else {
      cursor = sanitizeTransferCursor(body.cursor);
    }

    const progress = await transferDriveFoldersOwnership(
      tenant,
      fromUser,
      toUser,
      cursor
    );

    // Cap the error detail captured in the audit log so a pathological batch
    // can't blow up the line size. Full set is still in the JSON response.
    const FAILURE_DETAIL_CAP = 50;
    audit({
      action: "drive_transfer.chunk",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {
        fromUser,
        toUser,
        initialFolderCount: hasFolderIds ? initialFolderCount : undefined,
        transferred: progress.transferred,
        alreadyOwned: progress.alreadyOwned,
        notOwned: progress.notOwned,
        errorCount: progress.errors.length,
        hasMore: progress.nextCursor !== null,
        ...(progress.errors.length > 0
          ? { errors: progress.errors.slice(0, FAILURE_DETAIL_CAP) }
          : {}),
      },
      outcome: progress.errors.length > 0 ? "error" : "success",
      error:
        progress.errors.length > 0
          ? `${progress.errors.length} items failed during this chunk`
          : undefined,
    });

    return NextResponse.json({ success: true, data: progress });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Transfer failed";
    audit({
      action: "drive_transfer.chunk",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {
        fromUser,
        toUser,
        bodyKeys: Object.keys(body),
      },
      outcome: "error",
      error: message,
    });
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
