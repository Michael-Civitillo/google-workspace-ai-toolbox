import { NextRequest, NextResponse } from "next/server";
import {
  importMessageBatch,
  MAILBOX_IMPORT_BATCH_CAP,
  type ImportMessageInput,
} from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

// Raw messages carry attachments, so the import body is allowed to be large.
// A single base64url message can be ~72 MB (MAILBOX_MAX_RAW_CHARS), so the cap
// sits above that plus JSON envelope overhead — otherwise a lone max-size
// message could never fit once wrapped in `{ user, messages: [...] }`. The
// client batches by cumulative raw size well under this for multi-message
// batches, and sends a single oversized message on its own.
const MAX_BODY_BYTES = 80 * 1024 * 1024;

/**
 * Insert a batch of raw messages from an export into the target mailbox.
 *
 * POST /api/admin/mailbox-import
 * Body: { user, messages: [{ raw, labelIds }] }
 *
 * Mutating. messages.insert adds each message directly (no re-delivery, no
 * spam reclassification). Per-message outcomes are returned so the client can
 * surface partial failures and total progress. Note: importing is NOT
 * idempotent — re-running inserts duplicate copies. The UI gates this behind a
 * typed confirmation.
 *
 * The message payload (which contains mail content) is deliberately kept out
 * of the audit log — only counts are recorded.
 */
export async function POST(request: NextRequest) {
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json(
      { success: false, error: "Import batch is too large" },
      { status: 413 }
    );
  }

  const tenant = tenantFromRequest(request, body);
  let user: string | null = null;
  let batchSize = 0;
  try {
    user = requireEmail(body.user, "user");

    if (!Array.isArray(body.messages)) {
      throw new ValidationError("messages must be an array");
    }
    if (body.messages.length === 0) {
      throw new ValidationError("messages must not be empty");
    }
    if (body.messages.length > MAILBOX_IMPORT_BATCH_CAP) {
      throw new ValidationError(
        `Too many messages in one batch — cap is ${MAILBOX_IMPORT_BATCH_CAP}`
      );
    }
    batchSize = body.messages.length;

    const messages: ImportMessageInput[] = body.messages.map((m) => {
      const msg = (m ?? {}) as Record<string, unknown>;
      return {
        raw: typeof msg.raw === "string" ? msg.raw : "",
        labelIds: Array.isArray(msg.labelIds)
          ? (msg.labelIds.filter((x) => typeof x === "string") as string[])
          : undefined,
      };
    });

    const result = await importMessageBatch(tenant, user, messages);

    audit({
      action: "mailbox_import.batch",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {
        user,
        batchSize,
        inserted: result.inserted,
        failed: result.failed,
      },
      outcome: result.failed === 0 ? "success" : "error",
      error:
        result.failed > 0
          ? `${result.failed} of ${batchSize} message(s) failed to import`
          : undefined,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Mailbox import failed";
    audit({
      action: "mailbox_import.batch",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user, batchSize },
      outcome: "error",
      error: message,
    });
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
