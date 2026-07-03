import { NextRequest, NextResponse } from "next/server";
import { getUser, listOAuthTokens, isNotFoundError } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";

/**
 * Look up a user and surface everything we need to render the offboarding
 * confirmation diff: name, status, OAuth token count, etc. Read-only.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const user = requireEmail(
      request.nextUrl.searchParams.get("user"),
      "user"
    );

    // Don't fold a token-listing failure into "0 tokens": the confirmation
    // dialog would then promise "Revoke 0 OAuth tokens" for a user who may
    // have dozens. Report the count as unknown instead.
    const [info, tokens] = await Promise.all([
      getUser(tenant, user),
      listOAuthTokens(tenant, user).then(
        (t) => ({ list: t, error: null as string | null }),
        (e) => ({
          list: null,
          error: e instanceof Error ? e.message : String(e),
        })
      ),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        user: info,
        tokenCount: tokens.list ? tokens.list.length : null,
        tokens: (tokens.list ?? []).map((t) => ({
          clientId: t.clientId,
          displayText: t.displayText,
        })),
        tokensError: tokens.error,
      },
    });
  } catch (e) {
    if (isNotFoundError(e)) {
      return NextResponse.json(
        {
          success: false,
          error: "No user found with that email in this tenant.",
        },
        { status: 404 }
      );
    }
    const message = e instanceof Error ? e.message : "Preflight failed";
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
