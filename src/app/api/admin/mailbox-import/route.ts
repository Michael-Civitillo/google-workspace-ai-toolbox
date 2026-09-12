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
import { actorFromRequest } from "@/lib/session";
import { acquireSlot, BusyError } from "@/lib/concurrency";

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
 * Body: { user, confirm, messages: [{ raw, labelIds }] }
 *
 * Mutating. messages.insert adds each message directly (no re-delivery, no
 * spam reclassification). Per-message outcomes are returned so the client can
 * surface partial failures and total progress. Note: importing is NOT
 * idempotent — re-running inserts duplicate copies, so this route requires
 * `confirm` to equal the target `user`: the UI's typed confirmation is repeated
 * server-side because anything holding a session cookie can POST here.
 *
 * The message payload (which contains mail content) is deliberately kept out
 * of the audit log — only counts are recorded.
 */
export async function POST(request: NextRequest) {
  // Resolved before the try so the error path can attribute the failure too.
  const actor = await actorFromRequest(request);

  let tenant = null;
  let user: string | null = null;
  let batchSize = 0;
  let release: (() => void) | null = null;
  try {
    // One at a time: a body may be up to 80 MB and parsing plus base64 decoding
    // multiplies that, so two concurrent imports can exhaust a small host's
    // heap. Claimed before the body is read, so a request that has to wait is
    // turned away without buffering its payload first. The client sends its
    // batches strictly sequentially, so a single operator is never turned away.
    release = acquireSlot("mailbox-import", 1, "mailbox import");

    const body = await readCappedJson(request, MAX_BODY_BYTES);
    if (body === BODY_TOO_LARGE) {
      return NextResponse.json(
        { success: false, error: "Import batch is too large" },
        { status: 413 }
      );
    }

    // Resolve inside the try so a stale/deleted tenantId surfaces as this
    // route's JSON error (and its error-path audit) rather than an unhandled
    // non-JSON 500.
    tenant = tenantFromRequest(request, body);
    user = requireEmail(body.user, "user");

    // Importing is not idempotent — a replayed or accidental request duplicates
    // every message in the mailbox — so the destructive step is confirmed here
    // and not only in the browser dialog.
    const confirm =
      typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
    if (confirm !== user) {
      throw new ValidationError(
        "Type the target mailbox address into the confirm field to proceed."
      );
    }

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

    // Without the signal the batch keeps inserting after the operator cancels
    // (or a proxy hangs up), and their re-run duplicates every message that
    // landed after the cancel — insert has no dedup key.
    const result = await importMessageBatch(tenant, user, messages, {
      signal: request.signal,
    });

    audit({
      action: "mailbox_import.batch",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: {
        user,
        batchSize,
        inserted: result.inserted,
        failed: result.failed,
        // Cut short by the caller: record which messages actually landed, since
        // that is the only place the operator can look before re-running the
        // batch without duplicating them.
        ...(result.aborted
          ? {
              aborted: true,
              insertedIndexes: result.insertedIndexes ?? [],
            }
          : {}),
      },
      outcome: result.failed === 0 ? "success" : "error",
      error:
        result.failed > 0
          ? `${result.failed} of ${batchSize} message(s) failed to import`
          : undefined,
      actor,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    if (e instanceof BusyError) {
      return NextResponse.json(
        { success: false, error: e.message },
        { status: 429 }
      );
    }
    const message = e instanceof Error ? e.message : "Mailbox import failed";
    audit({
      action: "mailbox_import.batch",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user, batchSize },
      outcome: "error",
      error: message,
      actor,
    });
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  } finally {
    release?.();
  }
}
