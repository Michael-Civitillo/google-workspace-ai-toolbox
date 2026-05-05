import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import {
  getModel,
  ADMIN_ACTIONS,
  ACTION_PARAM_SCHEMAS,
  isKnownAction,
  type ActionId,
} from "@/lib/ai";
import { tenantFromRequest } from "@/lib/gws";

const BulkOperationSchema = z.object({
  operations: z.array(
    z.object({
      action: z.string().describe("The action ID"),
      params: z.record(z.string(), z.string()).describe("Parameters for the action"),
      description: z
        .string()
        .describe("Human-readable description of this operation"),
    })
  ),
  summary: z
    .string()
    .describe("Brief summary of all operations that will be performed"),
});

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 32_000;

export async function POST(request: NextRequest) {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {}
  try {
    const tenant = tenantFromRequest(request, body);
    const text = body.text;
    if (!text || typeof text !== "string") {
      return NextResponse.json(
        { success: false, error: "text is required" },
        { status: 400 }
      );
    }
    if (text.length > MAX_TEXT_CHARS) {
      return NextResponse.json(
        {
          success: false,
          error: `text too long (max ${MAX_TEXT_CHARS} chars)`,
        },
        { status: 413 }
      );
    }

    const actionsDescription = ADMIN_ACTIONS.map(
      (a) =>
        `- ${a.id}: ${a.name} — ${a.description}. Params: ${a.params.join(", ")}`
    ).join("\n");

    const { object } = await generateObject({
      model: getModel(tenant),
      schema: BulkOperationSchema,
      prompt: `You are a Google Workspace admin assistant. Parse the following text into a list of admin operations to perform.

Available actions:
${actionsDescription}

Important rules:
- Extract ALL operations mentioned in the text
- Each operation should be a separate item in the list
- If a single instruction applies to multiple users, create separate operations for each user
- Every email-shaped value MUST be a complete, valid email (e.g. user@domain.com), never a first name or partial
- Use ONLY the parameter names shown for each action — do not invent fields
- For calendar roles: "view" or "read" = reader, "edit" or "write" = writer, "full control" or "own" = owner
- Default calendar role to "reader" if not specified
- Default email forwarding action to "keep" if not specified
- Provide a clear description for each operation

Text to parse:
${JSON.stringify(text)}`,
    });

    // Enrich + validate every operation. The frontend will only allow
    // execution of operations whose params pass the per-action schema.
    const enriched = object.operations.map((op) => {
      const known = isKnownAction(op.action);
      const actionDef = known
        ? ADMIN_ACTIONS.find((a) => a.id === op.action)
        : undefined;
      let validParams = false;
      let validationError: string | null = null;
      if (known) {
        const schema = ACTION_PARAM_SCHEMAS[op.action as ActionId];
        const parsed = schema.safeParse(op.params);
        validParams = parsed.success;
        if (!parsed.success) {
          validationError = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
        }
      } else {
        validationError = `Unknown action "${op.action}"`;
      }
      return {
        ...op,
        endpoint: actionDef?.endpoint,
        method: actionDef?.method,
        actionName: actionDef?.name,
        knownAction: known,
        validParams,
        validationError,
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        operations: enriched,
        summary: object.summary,
        count: enriched.length,
        invalidCount: enriched.filter((o) => !o.validParams).length,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to parse operations";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
