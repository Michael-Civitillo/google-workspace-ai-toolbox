import { google } from "@ai-sdk/google";

/**
 * Get the configured Gemini model.
 * Set GOOGLE_GENERATIVE_AI_API_KEY in your environment.
 */
export function getModel() {
  return google("gemini-2.0-flash");
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
    description: "Transfer calendar ownership from one user to another",
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
] as const;

export type ActionId = (typeof ADMIN_ACTIONS)[number]["id"];
