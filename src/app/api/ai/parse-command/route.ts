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
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

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

const MAX_BODY_BYTES = 16 * 1024; // commands are short — cap to keep AI bills bounded
const MAX_COMMAND_CHARS = 4_000;

export async function POST(request: NextRequest) {
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  try {
    const tenant = tenantFromRequest(request, body);
    const command = body.command;
    if (!command || typeof command !== "string") {
      return NextResponse.json(
        { success: false, error: "command is required" },
        { status: 400 }
      );
    }
    if (command.length > MAX_COMMAND_CHARS) {
      return NextResponse.json(
        {
          success: false,
          error: `command too long (max ${MAX_COMMAND_CHARS} chars)`,
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
- Use ONLY the parameter names shown for each action — do not invent fields
- Every email-shaped value MUST be a complete, valid email (e.g. user@domain.com), never a first name or partial

User command: ${JSON.stringify(command)}`,
    });

    if (!isKnownAction(object.action)) {
      return NextResponse.json({
        success: false,
        error: `AI returned unknown action "${object.action}"`,
      });
    }

    // Validate params against the per-action schema. If validation fails we
    // still return the parsed action so the UI can surface the issue, but
    // mark `validParams: false` so the frontend won't allow execution.
    const schema = ACTION_PARAM_SCHEMAS[object.action as ActionId];
    const parsed = schema.safeParse(object.params);

    const actionDef = ADMIN_ACTIONS.find((a) => a.id === object.action);

    return NextResponse.json({
      success: true,
      data: {
        ...object,
        validParams: parsed.success,
        validationError: parsed.success
          ? null
          : parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
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
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
