import { NextRequest, NextResponse } from "next/server";
import { resolveImportLabels, type GmailLabelInfo } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";
import { audit } from "@/lib/audit";

// Label lists are small, but a mailbox near Gmail's ~10k-label ceiling with
// long names can still approach a few MB of JSON — give it headroom.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LABELS = 10_000;

/**
 * Recreate the source mailbox's labels in the target mailbox and return a
 * `{ sourceLabelId: targetLabelId }` map.
 *
 * POST /api/admin/mailbox-import/labels
 * Body: { user, labels: [{ id, name, type }] }
 *
 * Mutating (creates missing user labels), idempotent: an existing label is
 * matched by name rather than duplicated. Run once before streaming message
 * batches so label resolution stays out of the per-message insert loop.
 */
export async function POST(request: NextRequest) {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: "Label payload is too large" },
      { status: 413 }
    );
  }

  let raw = "";
  try {
    raw = await request.text();
  } catch {}
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: "Label payload is too large" },
      { status: 413 }
    );
  }
  let body: Record<string, unknown> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {}

  const tenant = tenantFromRequest(request, body);
  try {
    const user = requireEmail(body.user, "user");

    if (!Array.isArray(body.labels)) {
      throw new ValidationError("labels must be an array");
    }
    if (body.labels.length > MAX_LABELS) {
      throw new ValidationError(`Too many labels — cap is ${MAX_LABELS}`);
    }
    const labels: GmailLabelInfo[] = body.labels.map((l) => {
      const lab = (l ?? {}) as Record<string, unknown>;
      return {
        id: typeof lab.id === "string" ? lab.id : "",
        name: typeof lab.name === "string" ? lab.name : "",
        type: typeof lab.type === "string" ? lab.type : "user",
      };
    });

    const map = await resolveImportLabels(tenant, user, labels);

    audit({
      action: "mailbox_import.labels",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user, sourceLabels: labels.length, mapped: Object.keys(map).length },
      outcome: "success",
    });

    return NextResponse.json({ success: true, data: { map } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Label resolution failed";
    audit({
      action: "mailbox_import.labels",
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? null,
      params: { user: typeof body.user === "string" ? body.user : null },
      outcome: "error",
      error: message,
    });
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
