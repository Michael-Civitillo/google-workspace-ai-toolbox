import { NextRequest, NextResponse } from "next/server";
import { gws } from "@/lib/gws";

/**
 * List calendars for a user.
 * GET /api/gws/calendar-transfer?user=user@domain.com
 */
export async function GET(request: NextRequest) {
  const user = request.nextUrl.searchParams.get("user");

  if (!user) {
    return NextResponse.json(
      { error: "user parameter is required" },
      { status: 400 }
    );
  }

  // List the user's calendar list
  const result = await gws([
    "calendar",
    "calendarList",
    "list",
    `--calendarId=${user}`,
  ]);

  return NextResponse.json(result);
}

/**
 * Transfer calendar ownership by updating ACL.
 * This grants the new owner "owner" role and can optionally remove the old owner.
 *
 * POST /api/gws/calendar-transfer
 * Body: { sourceUser: string, targetUser: string, calendarId: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { sourceUser, targetUser, calendarId } = body;

  if (!sourceUser || !targetUser || !calendarId) {
    return NextResponse.json(
      { error: "sourceUser, targetUser, and calendarId are required" },
      { status: 400 }
    );
  }

  // Step 1: Grant owner access to the target user
  const grantResult = await gws([
    "calendar",
    "acl",
    "insert",
    `--calendarId=${calendarId}`,
    `--role=owner`,
    `--scope.type=user`,
    `--scope.value=${targetUser}`,
  ]);

  if (!grantResult.success) {
    return NextResponse.json({
      success: false,
      error: `Failed to grant ownership: ${grantResult.error}`,
      step: "grant_ownership",
    });
  }

  // Step 2: Remove the source user's access (optional, based on full transfer)
  const removeResult = await gws([
    "calendar",
    "acl",
    "delete",
    `--calendarId=${calendarId}`,
    `--ruleId=user:${sourceUser}`,
  ]);

  return NextResponse.json({
    success: true,
    data: {
      granted: grantResult.data,
      removed: removeResult.success ? removeResult.data : null,
      note: removeResult.success
        ? "Full transfer completed"
        : "Ownership granted but source user access was not removed (they may be the calendar creator)",
    },
  });
}
