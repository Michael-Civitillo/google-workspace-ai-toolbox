import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Tenant } from "./tenant-types";

/** Model used unless GEMINI_MODEL overrides it. */
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

// One provider per API key rather than one per call; keys are per tenant, so
// this stays tiny, and the cap only matters if tenants are churned.
const providerCache = new Map<string, ReturnType<typeof createGoogleGenerativeAI>>();
const PROVIDER_CACHE_MAX = 16;

/**
 * Get the configured Gemini model for a specific tenant.
 * Uses the tenant's geminiApiKey if set, otherwise falls back to
 * the GOOGLE_GENERATIVE_AI_API_KEY environment variable. The model id comes
 * from GEMINI_MODEL when set, so a newer model can be adopted without a
 * code change.
 */
export function getModel(tenant: Tenant | null) {
  const apiKey =
    tenant?.geminiApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "No Gemini API key configured. Set one on the Tenants page or set " +
        "GOOGLE_GENERATIVE_AI_API_KEY."
    );
  }

  let provider = providerCache.get(apiKey);
  if (!provider) {
    provider = createGoogleGenerativeAI({ apiKey });
    providerCache.set(apiKey, provider);
    while (providerCache.size > PROVIDER_CACHE_MAX) {
      const oldest = providerCache.keys().next().value;
      if (oldest === undefined) break;
      providerCache.delete(oldest);
    }
  }
  return provider(process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL);
}

/**
 * Whether an error is the abort of a timed-out request. The AI SDK wraps the
 * underlying DOMException in its own error classes, so a bare `name` check on
 * the outer error misses it and a timeout would surface as a generic 500
 * instead of a 504 — walk the `cause` chain and accept either abort name.
 */
export function isTimeoutError(e: unknown): boolean {
  let current: unknown = e;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current.name === "TimeoutError" || current.name === "AbortError") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Available admin actions the AI can map natural language to.
 */
export const ADMIN_ACTIONS = [
  {
    id: "email_delegation_add",
    name: "Add Email Delegate",
    description: "Grant someone access to read/send/delete in another user's mailbox",
    params: ["user (mailbox owner email)", "delegate (delegate email)"],
    endpoint: "/api/gws/email-delegation",
    method: "POST",
  },
  {
    id: "email_delegation_remove",
    name: "Remove Email Delegate",
    description: "Remove delegate access from a user's mailbox",
    params: ["user (mailbox owner email)", "delegate (delegate email)"],
    endpoint: "/api/gws/email-delegation",
    method: "DELETE",
  },
  {
    id: "email_delegation_list",
    name: "List Email Delegates",
    description: "Show who has delegate access to a user's mailbox",
    params: ["user (mailbox owner email)"],
    endpoint: "/api/gws/email-delegation",
    method: "GET",
  },
  {
    id: "calendar_delegation_add",
    name: "Add Calendar Access",
    description: "Grant someone access to view or edit another user's calendar",
    params: [
      "calendarId (calendar owner email)",
      "delegateEmail (user to grant access)",
      "role (freeBusyReader | reader | writer | owner)",
    ],
    endpoint: "/api/gws/calendar-delegation",
    method: "POST",
  },
  {
    id: "calendar_delegation_remove",
    name: "Remove Calendar Access",
    description: "Remove someone's access to a calendar",
    params: ["calendarId (calendar owner email)", "ruleId (user:email format)"],
    endpoint: "/api/gws/calendar-delegation",
    method: "DELETE",
  },
  {
    id: "calendar_delegation_list",
    name: "List Calendar Access",
    description: "Show who has access to a user's calendar",
    params: ["calendarId (calendar owner email)"],
    endpoint: "/api/gws/calendar-delegation",
    method: "GET",
  },
  {
    id: "calendar_transfer",
    name: "Transfer Calendar",
    description: "Transfer calendar ownership from one user to another (does NOT remove the source user's access — the AI must never opt into removeSourceAccess)",
    params: ["sourceUser", "targetUser", "calendarId (optional, defaults to primary)"],
    endpoint: "/api/gws/calendar-transfer",
    method: "POST",
  },
  {
    id: "email_transfer",
    name: "Set Up Email Forwarding",
    description: "Forward all incoming email from one user to another",
    params: [
      "sourceUser",
      "targetUser",
      "action (keep | archive | trash | markRead)",
    ],
    endpoint: "/api/gws/email-transfer",
    method: "POST",
  },
  {
    id: "domain_change",
    name: "Change Primary Domain",
    description: "Change a user's primary email address to a different domain",
    params: ["currentEmail", "newDomain", "newUsername (optional)"],
    endpoint: "/api/admin/change-domain",
    method: "POST",
  },
  {
    id: "group_member_add",
    name: "Add Group Member",
    description: "Add a user to a group (mailing list / access group)",
    params: [
      "group (group email)",
      "member (user email)",
      "role (MEMBER | MANAGER | OWNER, optional)",
    ],
    endpoint: "/api/admin/groups/members",
    method: "POST",
  },
  {
    id: "group_member_remove",
    name: "Remove Group Member",
    description: "Remove a user from a group",
    params: ["group (group email)", "member (user email)"],
    endpoint: "/api/admin/groups/members",
    method: "DELETE",
  },
  {
    id: "group_members_list",
    name: "List Group Members",
    description: "Show the members of a group",
    params: ["group (group email)"],
    endpoint: "/api/admin/groups/members",
    method: "GET",
  },
] as const;

export type ActionId = (typeof ADMIN_ACTIONS)[number]["id"];

/**
 * Per-action parameter schemas. The AI can hallucinate any field name; we use
 * these to (a) validate that all required fields are present and well-formed,
 * (b) pick out only the fields the API actually accepts so unrelated keys
 * don't sneak through, and (c) reject anything that isn't a valid email.
 */
import { z } from "zod";
import { isValidEmail } from "./validate";

const email = () =>
  z.string().refine(isValidEmail, { message: "must be a valid email address" });

const role = z.enum(["freeBusyReader", "reader", "writer", "owner"]);
const forwardAction = z.enum(["keep", "archive", "trash", "markRead"]);
const groupRole = z.enum(["MEMBER", "MANAGER", "OWNER"]);

export const ACTION_PARAM_SCHEMAS: Record<ActionId, z.ZodSchema> = {
  email_delegation_add: z.object({
    user: email(),
    delegate: email(),
  }),
  email_delegation_remove: z.object({
    user: email(),
    delegate: email(),
  }),
  email_delegation_list: z.object({
    user: email(),
  }),
  calendar_delegation_add: z.object({
    calendarId: email(),
    delegateEmail: email(),
    role,
  }),
  calendar_delegation_remove: z.object({
    calendarId: email(),
    ruleId: z.string().min(1),
  }),
  calendar_delegation_list: z.object({
    calendarId: email(),
  }),
  calendar_transfer: z.object({
    sourceUser: email(),
    targetUser: email(),
    calendarId: z.string().min(1).optional(),
  }),
  email_transfer: z.object({
    sourceUser: email(),
    targetUser: email(),
    action: forwardAction.optional(),
  }),
  domain_change: z.object({
    currentEmail: email(),
    newDomain: z.string().min(1),
    newUsername: z.string().optional(),
  }),
  group_member_add: z.object({
    group: email(),
    member: email(),
    role: groupRole.optional(),
  }),
  group_member_remove: z.object({
    group: email(),
    member: email(),
  }),
  group_members_list: z.object({
    group: email(),
  }),
};

export function isKnownAction(id: string): id is ActionId {
  return ADMIN_ACTIONS.some((a) => a.id === id);
}
