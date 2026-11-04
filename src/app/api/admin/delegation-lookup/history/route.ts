import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import { readAuditLogPage } from "@/lib/audit-reader";
import { getDelegationSightings } from "@/lib/delegation-sightings";
import { requireEmail, ValidationError, isValidEmail } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";

/**
 * How long has each of these delegations existed?
 *
 * GET /api/admin/delegation-lookup/history?delegate=sam@x.com&owners=a@x.com,b@x.com
 *
 * Touches no Google API. Two local sources, best first:
 *
 *   1. Open Admin's audit log — a successful `email_delegation.add` for the
 *      pair, with no later successful remove, gives the exact grant time and
 *      who ran it.
 *   2. The sightings store — when the pair was first observed by any
 *      delegate listing this app performed. A lower bound, not a grant date.
 *
 * Google itself does not expose a grant time, so a pair in neither source
 * comes back with both fields null and the UI says so plainly.
 */

const MAX_OWNERS = 100;
// The audit log rotates at 8 MB and the reader walks 512 KB windows, so a
// bound of 32 windows covers the whole live file with room to spare.
const MAX_AUDIT_WINDOWS = 32;

interface PairHistory {
  owner: string;
  /** Exact grant time from Open Admin's audit log, when known. */
  grantedAt: string | null;
  /** Operator who ran the grant, from the same audit entry. */
  grantedBy: string | null;
  /** When any Open Admin delegate listing first saw this pair. */
  firstSeenAt: string | null;
}

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const params = request.nextUrl.searchParams;
    const delegate = requireEmail(params.get("delegate"), "delegate").toLowerCase();

    const ownersRaw = (params.get("owners") || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    if (ownersRaw.length === 0) {
      throw new ValidationError("owners must list at least one mailbox");
    }
    if (ownersRaw.length > MAX_OWNERS) {
      throw new ValidationError(`owners may list at most ${MAX_OWNERS} mailboxes`);
    }
    for (const o of ownersRaw) {
      if (!isValidEmail(o)) {
        throw new ValidationError(`owners contains an invalid email: ${o}`);
      }
    }
    const owners = [...new Set(ownersRaw)];
    const ownerSet = new Set(owners);

    // Walk the audit log newest-first and keep, per owner, the latest
    // successful add and the latest successful remove for this delegate.
    const latestAdd = new Map<string, { ts: number; iso: string; actor: string | null }>();
    const latestRemove = new Map<string, number>();
    let cursor: number | null = null;
    for (let i = 0; i < MAX_AUDIT_WINDOWS; i++) {
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
        const user =
          typeof p?.user === "string" ? p.user.toLowerCase() : null;
        const d =
          typeof p?.delegate === "string" ? p.delegate.toLowerCase() : null;
        if (!user || d !== delegate || !ownerSet.has(user)) continue;
        const ts = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
        if (Number.isNaN(ts)) continue;
        if (entry.action === "email_delegation.add") {
          const prev = latestAdd.get(user);
          if (!prev || ts > prev.ts) {
            latestAdd.set(user, {
              ts,
              iso: entry.ts as string,
              actor: typeof entry.actor === "string" ? entry.actor : null,
            });
          }
        } else if (entry.action === "email_delegation.remove") {
          const prev = latestRemove.get(user);
          if (prev === undefined || ts > prev) latestRemove.set(user, ts);
        }
      }
      if (page.done || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    const sightings = getDelegationSightings(tenant?.id ?? null, delegate, owners);

    const history: PairHistory[] = owners.map((owner) => {
      const add = latestAdd.get(owner);
      const removedAt = latestRemove.get(owner);
      // A remove after the latest add means the delegation that exists now
      // was granted somewhere else: the audit entry is not its start.
      const granted =
        add && (removedAt === undefined || removedAt < add.ts) ? add : null;
      const seen = sightings.get(owner);
      return {
        owner,
        grantedAt: granted ? granted.iso : null,
        grantedBy: granted ? granted.actor : null,
        firstSeenAt: seen ? seen.firstSeen : null,
      };
    });

    return NextResponse.json({ success: true, data: { delegate, history } });
  } catch (e) {
    return errorResponse(e, "Delegation history lookup failed");
  }
}
