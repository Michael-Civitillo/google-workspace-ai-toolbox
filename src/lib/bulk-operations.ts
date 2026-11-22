/**
 * Bulk Operations: what each operation is called, which columns it reads,
 * how a row is checked before anything runs, and the request a row becomes.
 *
 * Every operation calls the same API route its own page uses, one row at a
 * time, so each row is validated again on the server and audited on its own.
 * Nothing here talks to the network: the page does that. Keeping the rules in
 * a plain module lets the page share them and the tests exercise them.
 */
import { isValidEmail } from "./validate-email";

export type OperationId =
  | "delegation_add"
  | "delegation_remove"
  | "set_forwarding"
  | "group_add"
  | "group_remove"
  | "calendar_share"
  | "suspend"
  | "unsuspend";

export interface OperationDef {
  label: string;
  endpoint: string;
  method: "POST" | "DELETE";
  columns: [string, ...string[]];
  hint: string;
  /** A sample data row, shown as the placeholder under the header. */
  example: string;
  /** Map a parsed row's cells to the request body. */
  toBody: (cells: string[]) => Record<string, string>;
  /** Returns what is wrong with the row, or null when it can run. */
  validateRow: (cells: string[]) => string | null;
  /**
   * The word typed, with the row count, to start the run. "RUN" unless the
   * operation is one where the operator should have to name what it does.
   */
  confirmVerb?: string;
  /** Shown in the confirmation dialog, above the phrase. */
  warning?: string;
}

const FORWARD_ACTIONS = ["keep", "archive", "trash", "markRead"] as const;
const GROUP_ROLES = ["MEMBER", "MANAGER", "OWNER"] as const;
/**
 * Calendar roles offered in bulk. Making someone an owner hands over the
 * calendar itself, and for an outside address needs its own confirmation, so
 * that stays on the Calendar Delegation page.
 */
const CALENDAR_ROLES = ["freeBusyReader", "reader", "writer"] as const;

/** The spelling the API expects for a value typed in any letter case. */
function canonical<T extends string>(value: string, allowed: readonly T[]): T | null {
  return allowed.find((a) => a.toLowerCase() === value.trim().toLowerCase()) ?? null;
}

export function baselineEmails(
  cells: string[],
  firstName: string,
  secondName: string
): string | null {
  if (cells.length < 2 || !cells[0] || !cells[1]) {
    return `needs two columns: ${firstName}, ${secondName}`;
  }
  if (!isValidEmail(cells[0])) return `${firstName} is not a valid email`;
  if (!isValidEmail(cells[1])) return `${secondName} is not a valid email`;
  if (cells[0].toLowerCase() === cells[1].toLowerCase()) {
    return `${firstName} and ${secondName} must be different`;
  }
  return null;
}

function singleEmail(cells: string[], name: string): string | null {
  if (!cells[0]) return `needs one column: ${name}`;
  if (!isValidEmail(cells[0])) return `${name} is not a valid email`;
  // A second address on the row is almost certainly a file meant for another
  // operation. Running it anyway would act on the first column only.
  if (cells.slice(1).some((c) => c !== "")) {
    return `only one column is expected: ${name}`;
  }
  return null;
}

export const OPERATIONS: Record<OperationId, OperationDef> = {
  delegation_add: {
    label: "Add email delegate",
    endpoint: "/api/gws/email-delegation",
    method: "POST",
    columns: ["user", "delegate"],
    hint: "One row per grant: the mailbox owner, then the delegate to add.",
    example: "alice@yourdomain.com,bob@yourdomain.com",
    toBody: (c) => ({ user: c[0], delegate: c[1] }),
    validateRow: (c) => baselineEmails(c, "user", "delegate"),
  },
  delegation_remove: {
    label: "Remove email delegate",
    endpoint: "/api/gws/email-delegation",
    method: "DELETE",
    columns: ["user", "delegate"],
    hint: "One row per removal: the mailbox owner, then the delegate to remove.",
    example: "alice@yourdomain.com,bob@yourdomain.com",
    toBody: (c) => ({ user: c[0], delegate: c[1] }),
    validateRow: (c) => baselineEmails(c, "user", "delegate"),
  },
  set_forwarding: {
    label: "Set up email forwarding",
    endpoint: "/api/gws/email-transfer",
    method: "POST",
    columns: ["sourceUser", "targetUser", "action (optional)"],
    hint: "One row per mailbox: source, forward-to target, and optionally what happens to originals (keep, archive, trash, markRead — defaults to keep).",
    example: "alice@yourdomain.com,bob@yourdomain.com,keep",
    toBody: (c) => ({
      sourceUser: c[0],
      targetUser: c[1],
      action: c[2] || "keep",
    }),
    validateRow: (c) => {
      const base = baselineEmails(c, "sourceUser", "targetUser");
      if (base) return base;
      if (c[2] && !(FORWARD_ACTIONS as readonly string[]).includes(c[2])) {
        return `action must be one of: ${FORWARD_ACTIONS.join(", ")}`;
      }
      return null;
    },
    warning:
      "Rows that forward to an address outside this tenant's verified domains are rejected by the server (they need the dedicated Email Transfer page's external confirmation) and will show as failed.",
  },
  group_add: {
    label: "Add group member",
    endpoint: "/api/admin/groups/members",
    method: "POST",
    columns: ["group", "member", "role (optional)"],
    hint: "One row per membership: the group's address, the person to add, and optionally their role (MEMBER, MANAGER or OWNER). Leave the role out to add ordinary members without touching anyone who is already in the group.",
    example: "all-staff@yourdomain.com,alice@yourdomain.com",
    toBody: (c) => {
      const role = c[2] ? canonical(c[2], GROUP_ROLES) : null;
      return {
        group: c[0],
        member: c[1],
        ...(role ? { role } : {}),
        // The server asks for the owner's address typed out; the run's own
        // typed confirmation stands for that here, as for bulk suspend.
        ...(role === "OWNER" ? { confirm: c[1] } : {}),
      };
    },
    validateRow: (c) => {
      const base = baselineEmails(c, "group", "member");
      if (base) return base;
      if (c[2] && !canonical(c[2], GROUP_ROLES)) {
        return `role must be one of: ${GROUP_ROLES.join(", ")}`;
      }
      return null;
    },
    warning:
      "A row that names a role sets that role even for someone already in the group, so it can demote an owner or manager. Rows without a role never change an existing member. Rows that add someone outside this tenant's domains are refused by the server (add them on the Groups page, which asks you to confirm the outside address) and will show as failed.",
  },
  group_remove: {
    label: "Remove group member",
    endpoint: "/api/admin/groups/members",
    method: "DELETE",
    columns: ["group", "member"],
    hint: "One row per removal: the group's address, then the person to take out of it.",
    example: "all-staff@yourdomain.com,alice@yourdomain.com",
    // The route wants the member's address repeated as its confirmation. Here
    // the typed phrase for the whole run is that confirmation.
    toBody: (c) => ({ group: c[0], member: c[1], confirm: c[1] }),
    validateRow: (c) => baselineEmails(c, "group", "member"),
    confirmVerb: "REMOVE",
    warning:
      "Each person loses whatever the group gave them: its mail, and any files, calendars or sites shared with the group.",
  },
  calendar_share: {
    label: "Share a calendar",
    endpoint: "/api/gws/calendar-delegation",
    method: "POST",
    columns: ["calendar", "shareWith", "role (optional)"],
    hint: "One row per share: whose calendar, who gets access, and optionally how much (freeBusyReader, reader or writer — defaults to reader). To make someone an owner, use the Calendar Delegation page.",
    example: "alice@yourdomain.com,bob@yourdomain.com,reader",
    toBody: (c) => ({
      calendarId: c[0],
      delegateEmail: c[1],
      role: (c[2] && canonical(c[2], CALENDAR_ROLES)) || "reader",
    }),
    validateRow: (c) => {
      const base = baselineEmails(c, "calendar", "shareWith");
      if (base) return base;
      if (c[2] && !canonical(c[2], CALENDAR_ROLES)) {
        return /^owner$/i.test(c[2].trim())
          ? "owner can't be granted in bulk; use the Calendar Delegation page"
          : `role must be one of: ${CALENDAR_ROLES.join(", ")}`;
      }
      return null;
    },
    warning:
      "Sharing with an address outside your organisation is allowed here, as it is on the Calendar Delegation page. Check the shareWith column before you start.",
  },
  suspend: {
    label: "Suspend accounts",
    endpoint: "/api/offboarding/step",
    method: "POST",
    columns: ["user"],
    hint: "One account per row. Each is signed out and can't sign in again until it is re-enabled. Mail still arrives and nothing is deleted. For someone leaving for good, Offboarding does more (forwarding, transfers, group removal).",
    example: "alice@yourdomain.com",
    toBody: (c) => ({ step: "suspend", user: c[0], confirm: c[0] }),
    validateRow: (c) => singleEmail(c, "user"),
    confirmVerb: "SUSPEND",
    warning:
      "Every account in the list is locked out as its row runs. Read the list once more: a file with the wrong people in it locks them out too. \"Re-enable accounts\" with the same file undoes it.",
  },
  unsuspend: {
    label: "Re-enable accounts",
    endpoint: "/api/admin/user/unsuspend",
    method: "POST",
    columns: ["user"],
    hint: "One suspended account per row. Each can sign in again and starts receiving what the suspension held back.",
    example: "alice@yourdomain.com",
    toBody: (c) => ({ user: c[0], confirm: c[0] }),
    validateRow: (c) => singleEmail(c, "user"),
    confirmVerb: "ENABLE",
    warning:
      "Each person gets back in with the password they had. If an account was suspended because it was compromised, reset its password first.",
  },
};

/** The phrase typed to start a run of `count` rows. */
export function confirmPhraseFor(def: OperationDef, count: number): string {
  return `${def.confirmVerb ?? "RUN"} ${count}`;
}

/**
 * Minimal RFC 4180-style CSV parser: quoted cells, doubled quotes as escapes,
 * commas inside quotes, and CR/LF/CRLF row endings. Unquoted cells are
 * trimmed; fully empty rows are dropped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellWasQuoted = false;

  const endCell = () => {
    row.push(cellWasQuoted ? cell : cell.trim());
    cell = "";
    cellWasQuoted = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cellWasQuoted = true;
      cell = "";
      continue;
    }
    if (ch === ",") {
      endCell();
      continue;
    }
    if (ch === "\n") {
      endRow();
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Rows that would do the same thing as an earlier row, by index. The first
 * of each set runs; the repeats are skipped rather than sent to Google twice.
 */
export function duplicateRows(rows: string[][], def: OperationDef): Set<number> {
  const seen = new Set<string>();
  const repeats = new Set<number>();
  rows.forEach((cells, index) => {
    if (def.validateRow(cells)) return;
    const key = JSON.stringify(def.toBody(cells)).toLowerCase();
    if (seen.has(key)) repeats.add(index);
    else seen.add(key);
  });
  return repeats;
}
