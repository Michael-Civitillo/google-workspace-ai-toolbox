import { NextRequest, NextResponse } from "next/server";
import { changePrimaryDomain } from "@/lib/admin-sdk";

/**
 * Change a user's primary domain.
 * POST /api/admin/change-domain
 * Body: { currentEmail: string, newDomain: string, newUsername?: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { currentEmail, newDomain, newUsername } = body;

  if (!currentEmail || !newDomain) {
    return NextResponse.json(
      { error: "currentEmail and newDomain are required" },
      { status: 400 }
    );
  }

  try {
    const result = await changePrimaryDomain(
      currentEmail,
      newDomain,
      newUsername || undefined
    );
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to change domain";
    return NextResponse.json({ success: false, error: message });
  }
}
