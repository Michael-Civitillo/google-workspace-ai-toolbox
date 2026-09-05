import { NextRequest, NextResponse } from "next/server";
import { identityFromRequest } from "@/lib/session";

/** Who the current session belongs to — drives the "signed in as" footer. */
export async function GET(req: NextRequest) {
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
