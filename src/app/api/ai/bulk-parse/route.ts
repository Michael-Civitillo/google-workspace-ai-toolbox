import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { getModel, ADMIN_ACTIONS } from "@/lib/ai";

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
    .describe(
      "Brief summary of all operations that will be performed"
    ),
});

/**
 * Parse bulk plain-text instructions into a list of structured operations.
 * POST /api/ai/bulk-parse
 * Body: { text: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { text } = await request.json();

    if (!text) {
      return NextResponse.json(
        { error: "text is required" },
        { status: 400 }
      );
    }

    const actionsDescription = ADMIN_ACTIONS.map(
      (a) =>
        `- ${a.id}: ${a.name} — ${a.description}. Params: ${a.params.join(", ")}`
    ).join("\n");

    const { object } = await generateObject({
      model: getModel(),
      schema: BulkOperationSchema,
      prompt: `You are a Google Workspace admin assistant. Parse the following text into a list of admin operations to perform.

Available actions:
${actionsDescription}

Important rules:
- Extract ALL operations mentioned in the text
- Each operation should be a separate item in the list
- If a single instruction applies to multiple users, create separate operations for each user
- Extract all email addresses accurately
- For calendar roles: "view" or "read" = reader, "edit" or "write" = writer, "full control" or "own" = owner
- Default calendar role to "reader" if not specified
- Default email forwarding action to "keep" if not specified
- If the text is a list of users with the same action, create one operation per user
- Provide a clear description for each operation

Text to parse:
"""
${text}
"""`,
    });

    // Enrich each operation with endpoint/method info
    const enriched = object.operations.map((op) => {
      const actionDef = ADMIN_ACTIONS.find((a) => a.id === op.action);
      return {
        ...op,
        endpoint: actionDef?.endpoint,
        method: actionDef?.method,
        actionName: actionDef?.name,
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        operations: enriched,
        summary: object.summary,
        count: enriched.length,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to parse operations";
    return NextResponse.json({ success: false, error: message });
  }
}
