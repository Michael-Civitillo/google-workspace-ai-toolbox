import { NextRequest, NextResponse } from "next/server";
import { getUser, listOAuthTokens } from "@/lib/admin-sdk";
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

    const [info, tokens] = await Promise.all([
      getUser(tenant, user),
      listOAuthTokens(tenant, user).catch(() => []),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        user: info,
        tokenCount: tokens.length,
        tokens: tokens.map((t) => ({
          clientId: t.clientId,
          displayText: t.displayText,
        })),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Preflight failed";
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
