import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/admin-sdk";

/**
 * Look up a user by email.
 * GET /api/admin/user?email=user@domain.com
 */
export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get("email");

  if (!email) {
    return NextResponse.json(
      { error: "email parameter is required" },
      { status: 400 }
    );
  }

  try {
    const user = await getUser(email);
    return NextResponse.json({ success: true, data: user });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to look up user";
    return NextResponse.json({ success: false, error: message });
  }
}
