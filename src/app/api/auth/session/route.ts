import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { identityFromRequest } from "@/lib/session";

/** Who the current session belongs to — drives the "signed in as" footer. */
export async function GET(req: NextRequest) {
  const noSession = await sessionRefusal(req);
  if (noSession) return noSession;
  const identity = await identityFromRequest(req);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(
    {
      method: identity.method,
      email: identity.email ?? null,
      name: identity.name ?? null,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
