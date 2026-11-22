import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { tenantFromRequest } from "@/lib/gws";
import { readAuditLogPage, type AuditCursor } from "@/lib/audit-reader";
import { getDelegationSightings } from "@/lib/delegation-sightings";
import { ValidationError, isValidEmail } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * How long has each of these delegations existed?
 *
 * POST /api/admin/delegation-lookup/history
 * Body: { pairs: [{ owner: "a@x.com", delegate: "sam@x.com" }, ...] }
 *
 * `delegate` is the address the mailbox stores for the grant (the delegate's
 * primary address or one of its aliases), so a grant made to an alias finds
 * its own history. All pairs of a lookup go in one request: the audit log is
 * walked once for the lot, not once per batch of mailboxes.
 *
 * A POST only because a long list of mailboxes does not fit in a URL. It
 * touches no Google API and changes nothing. Two local sources, best first:
 *
 *   1. Open Admin's audit log (the live file and its archives) — a successful
 *      `email_delegation.add` for the pair, with no later successful remove,
 *      gives the exact grant time and who ran it.
 *   2. The sightings store — when the pair was first observed by any
 *      delegate listing this app performed. A lower bound, not a grant date.
 *
 * Google itself does not expose a grant time, so a pair in neither source
 * comes back with both fields null and the UI says so plainly.
 */

const MAX_PAIRS = 5000;
const MAX_BODY_BYTES = 1024 * 1024;
// The log rotates at 8 MB and keeps three archives; the reader walks 512 KB
// windows, so 64 calls cover all four files. The bound leaves room for
// windows split by many matching entries, and for a live file that grew past
// the cap because a rotation failed.
const MAX_AUDIT_CALLS = 160;

interface PairHistory {
  owner: string;
  delegate: string;
  /** Exact grant time from Open Admin's audit log, when known. */
  grantedAt: string | null;
  /** Operator who ran the grant, from the same audit entry. */
  grantedBy: string | null;
  /** When any Open Admin delegate listing first saw this pair. */
  firstSeenAt: string | null;
}

const pairKey = (owner: string, delegate: string) => `${owner}|${delegate}`;

function readPairs(body: Record<string, unknown>): Array<{ owner: string; delegate: string }> {
  if (!Array.isArray(body.pairs)) {
    throw new ValidationError("pairs must be an array of { owner, delegate }");
  }
  if (body.pairs.length === 0) {
    throw new ValidationError("pairs must list at least one mailbox");
  }
  if (body.pairs.length > MAX_PAIRS) {
    throw new ValidationError(`pairs may list at most ${MAX_PAIRS} mailboxes`);
  }
  const seen = new Set<string>();
  const pairs: Array<{ owner: string; delegate: string }> = [];
  for (const raw of body.pairs) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const owner = typeof p.owner === "string" ? p.owner.trim().toLowerCase() : "";
    const delegate =
      typeof p.delegate === "string" ? p.delegate.trim().toLowerCase() : "";
    if (!isValidEmail(owner) || !isValidEmail(delegate)) {
      throw new ValidationError(
        "each pair needs a valid owner and delegate email address"
      );
    }
    const key = pairKey(owner, delegate);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ owner, delegate });
  }
  return pairs;
}

export async function POST(request: NextRequest) {
  const noSession = await sessionRefusal(request);
  if (noSession) return noSession;
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json(
      { success: false, error: "Too many mailboxes in one request" },
      { status: 413 }
    );
  }
  try {
    const tenant = tenantFromRequest(request, body);
    const pairs = readPairs(body);
    const wanted = new Set(pairs.map((p) => pairKey(p.owner, p.delegate)));

    // Walk the audit log newest-first and keep, per pair, the latest
    // successful add and the latest successful remove.
    const latestAdd = new Map<string, { ts: number; iso: string; actor: string | null }>();
    const latestRemove = new Map<string, number>();
    let cursor: AuditCursor | null = null;
    let auditComplete = false;
    for (let i = 0; i < MAX_AUDIT_CALLS; i++) {
      const page = await readAuditLogPage({
        cursor,
        maxEntries: 500,
        filters: {
          action: "email_delegation.",
          outcome: "success",
          tenantId: tenant?.id ?? undefined,
        },
      });
      for (const entry of page.entries) {
        const p = entry.params as Record<string, unknown> | undefined;
        const user = typeof p?.user === "string" ? p.user.toLowerCase() : null;
        const d = typeof p?.delegate === "string" ? p.delegate.toLowerCase() : null;
        if (!user || !d) continue;
        const key = pairKey(user, d);
        if (!wanted.has(key)) continue;
        const ts = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
        if (Number.isNaN(ts)) continue;
        if (entry.action === "email_delegation.add") {
          const prev = latestAdd.get(key);
          if (!prev || ts > prev.ts) {
            latestAdd.set(key, {
              ts,
              iso: entry.ts as string,
              actor: typeof entry.actor === "string" ? entry.actor : null,
            });
          }
        } else if (entry.action === "email_delegation.remove") {
          const prev = latestRemove.get(key);
          if (prev === undefined || ts > prev) latestRemove.set(key, ts);
        }
      }
      if (page.done || page.nextCursor === null) {
        auditComplete = true;
        break;
      }
      cursor = page.nextCursor;
    }

    // One sightings read per delegate address (the primary and any aliases
    // the grants name), not per mailbox.
    const ownersByDelegate = new Map<string, string[]>();
    for (const p of pairs) {
      const list = ownersByDelegate.get(p.delegate) ?? [];
      list.push(p.owner);
      ownersByDelegate.set(p.delegate, list);
    }
    const sightings = new Map<string, { firstSeen: string }>();
    for (const [delegate, owners] of ownersByDelegate) {
      const found = getDelegationSightings(tenant?.id ?? null, delegate, owners);
      for (const [owner, rec] of found) sightings.set(pairKey(owner, delegate), rec);
    }

    const history: PairHistory[] = pairs.map(({ owner, delegate }) => {
      const key = pairKey(owner, delegate);
      const add = latestAdd.get(key);
      const removedAt = latestRemove.get(key);
      // A remove after the latest add means the delegation that exists now
      // was granted somewhere else: the audit entry is not its start.
      const granted =
        add && (removedAt === undefined || removedAt < add.ts) ? add : null;
      const seen = sightings.get(key);
      return {
        owner,
        delegate,
        grantedAt: granted ? granted.iso : null,
        grantedBy: granted ? granted.actor : null,
        firstSeenAt: seen ? seen.firstSeen : null,
      };
    });

    return NextResponse.json({
      success: true,
      data: { history, auditComplete },
    });
  } catch (e) {
    return errorResponse(e, "Delegation history lookup failed");
  }
}
