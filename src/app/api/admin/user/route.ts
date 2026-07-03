import { NextRequest, NextResponse } from "next/server";
import { getUser, isNotFoundError } from "@/lib/admin-sdk";
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
    // A typo'd address is the most common outcome of this lookup — answer it
    // with a clean 404 instead of a 500 wrapping Google's raw error text.
    if (isNotFoundError(error)) {
      return NextResponse.json(
        {
          success: false,
          error: "No user found with that email in this tenant.",
        },
        { status: 404 }
      );
    }
    const message =
      error instanceof Error ? error.message : "Failed to look up user";
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
