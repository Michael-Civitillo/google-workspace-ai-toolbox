import { NextRequest, NextResponse } from "next/server";
import { tenantFromRequest } from "@/lib/gws";
import {
  findMailboxesDelegatedTo,
  getUser,
  isNotFoundError,
} from "@/lib/admin-sdk";
import { recordDelegationSightings } from "@/lib/delegation-sightings";
import { requireEmail, ValidationError } from "@/lib/validate";
import { errorResponse } from "@/lib/api-errors";

/**
 * Reverse delegation lookup: every mailbox a user has delegate access to.
 *
 * GET /api/admin/delegation-lookup?delegate=sam@yourdomain.com
 *       [&pageToken=...][&pageSize=100]
 *
 * Read-only against Google. Gmail only lists delegates per mailbox, so this
 * walks one page of the tenant's users per call and reports which of them
 * name the delegate; the client chains calls on `nextPageToken` until it is
 * null, showing progress and allowing cancellation in between. Suspended
 * accounts are counted and skipped — Google will not impersonate them, so
 * their delegate lists cannot be read.
 *
 * Side effect, local only: every delegation observed on the page is recorded
 * as a first-seen sighting (see delegation-sightings.ts) so the history
 * endpoint can later say how long a delegation has at least existed.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const params = request.nextUrl.searchParams;
    const delegateInput = requireEmail(params.get("delegate"), "delegate");

    const rawPageToken = params.get("pageToken");
    let pageToken: string | undefined;
    if (rawPageToken !== null) {
      if (rawPageToken.length === 0 || rawPageToken.length > 4096) {
        throw new ValidationError("pageToken is malformed");
      }
      pageToken = rawPageToken;
    }

    const pageSizeRaw = params.get("pageSize");
    let pageSize: number | undefined;
    if (pageSizeRaw) {
      const n = Number(pageSizeRaw);
      if (!Number.isInteger(n)) {
        throw new ValidationError("pageSize must be an integer");
      }
      pageSize = Math.min(200, Math.max(1, n));
    }

    // Resolve the delegate first: a typo should come back as "no such user",
    // not as a full tenant scan that finds nothing. The alias set matters
    // because Gmail stores whichever address the grant named.
    let delegateUser;
    try {
      delegateUser = await getUser(tenant, delegateInput);
    } catch (e) {
      if (isNotFoundError(e)) {
        return NextResponse.json(
          {
            success: false,
            error: `No user ${delegateInput} in this tenant`,
          },
          { status: 404 }
        );
      }
      throw e;
    }
    const delegateEmails = new Set<string>();
    delegateEmails.add(delegateInput.toLowerCase());
    if (delegateUser.primaryEmail) {
      delegateEmails.add(delegateUser.primaryEmail.toLowerCase());
    }
    for (const e of delegateUser.emails || []) {
      if (e?.address) delegateEmails.add(e.address.toLowerCase());
    }

    const page = await findMailboxesDelegatedTo(tenant, {
      delegateEmails,
      pageToken,
      pageSize,
      signal: request.signal,
    });

    // Record before answering so the client's follow-up history call sees
    // this page's sightings. Never throws.
    await recordDelegationSightings(tenant?.id ?? null, page.sightings);

    return NextResponse.json({
      success: true,
      data: {
        delegate: {
          primaryEmail: delegateUser.primaryEmail.toLowerCase(),
          fullName: delegateUser.name.fullName,
          suspended: delegateUser.suspended,
          aliases: [...delegateEmails].filter(
            (a) => a !== delegateUser.primaryEmail.toLowerCase()
          ),
        },
        matches: page.matches,
        scannedUsers: page.scannedUsers,
        skippedSuspended: page.skippedSuspended,
        unscanned: page.unscanned,
        nextPageToken: page.nextPageToken,
      },
    });
  } catch (e) {
    return errorResponse(e, "Delegation lookup failed");
  }
}
