import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { getModel, ADMIN_ACTIONS } from "@/lib/ai";

const ParsedCommandSchema = z.object({
  action: z.string().describe("The action ID from the available actions list"),
  params: z
    .record(z.string(), z.string())
    .describe("Key-value pairs of parameters for the action"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident you are this is the right interpretation (0-1)"),
  explanation: z
    .string()
    .describe("Brief plain-English explanation of what this will do"),
});

/**
 * Parse a natural language command into a structured admin action.
 * POST /api/ai/parse-command
 * Body: { command: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { command } = await request.json();

    if (!command) {
      return NextResponse.json(
        { error: "command is required" },
        { status: 400 }
      );
    }

    const actionsDescription = ADMIN_ACTIONS.map(
      (a) =>
        `- ${a.id}: ${a.name} — ${a.description}. Params: ${a.params.join(", ")}`
    ).join("\n");

    const { object } = await generateObject({
      model: getModel(),
      schema: ParsedCommandSchema,
      prompt: `You are a Google Workspace admin assistant. Parse the following natural language command into a structured action.

Available actions:
${actionsDescription}

Important rules:
- If the command mentions "delegate", "give access", "grant access" to email/mailbox, use email_delegation_add
- If the command mentions "share calendar", "calendar access", use calendar_delegation_add
- If the command mentions "transfer calendar", "move calendar", use calendar_transfer
- If the command mentions "forward email", "transfer email", use email_transfer
- If the command mentions "change domain", "switch domain", "move to domain", use domain_change
- If the command mentions "who has access", "list delegates", "show access", use the appropriate _list action
- If the command mentions "remove", "revoke", "take away", use the appropriate _remove action
- For calendar roles: "view" or "read" = reader, "edit" or "write" = writer, "full control" or "own" = owner, "free/busy" = freeBusyReader
- Default calendar role to "reader" if not specified
- Default email forwarding action to "keep" if not specified
- Extract email addresses from the text. If only a first name is used, leave the email field with just the name and a note

User command: "${command}"`,
    });

    // Find the matching action details
    const actionDef = ADMIN_ACTIONS.find((a) => a.id === object.action);

    return NextResponse.json({
      success: true,
      data: {
        ...object,
        actionDetails: actionDef
          ? {
              name: actionDef.name,
              endpoint: actionDef.endpoint,
              method: actionDef.method,
            }
          : null,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to parse command";
    return NextResponse.json({ success: false, error: message });
  }
}
