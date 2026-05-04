import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/admin-sdk";
import { tenantFromRequest } from "@/lib/gws";
import { requireEmail, ValidationError } from "@/lib/validate";

export async function GET(request: NextRequest) {
  try {
    const tenant = tenantFromRequest(request);
    const email = requireEmail(
      request.nextUrl.searchParams.get("email"),
      "email"
    );
    const user = await getUser(tenant, email);
    return NextResponse.json({ success: true, data: user });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to look up user";
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
