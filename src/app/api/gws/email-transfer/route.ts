import { NextRequest, NextResponse } from "next/server";
import { gws } from "@/lib/gws";

/**
 * List labels/folders for a user (to show what will be transferred).
 * GET /api/gws/email-transfer?user=user@domain.com
 */
export async function GET(request: NextRequest) {
  const user = request.nextUrl.searchParams.get("user");

  if (!user) {
    return NextResponse.json(
      { error: "user parameter is required" },
      { status: 400 }
    );
  }

  const result = await gws([
    "gmail",
    "users",
    "labels",
    "list",
    `--userId=${user}`,
  ]);

  return NextResponse.json(result);
}

/**
 * Set up email forwarding from source to target user.
 * This creates a forwarding address and enables auto-forwarding.
 *
 * POST /api/gws/email-transfer
 * Body: { sourceUser: string, targetUser: string, action: "keep" | "archive" | "trash" | "markRead" }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { sourceUser, targetUser, action = "keep" } = body;

  if (!sourceUser || !targetUser) {
    return NextResponse.json(
      { error: "sourceUser and targetUser are required" },
      { status: 400 }
    );
  }

  // Step 1: Create forwarding address
  const forwardResult = await gws([
    "gmail",
    "users",
    "settings",
    "forwardingAddresses",
    "create",
    `--userId=${sourceUser}`,
    `--forwardingEmail=${targetUser}`,
  ]);

  if (!forwardResult.success) {
    return NextResponse.json({
      success: false,
      error: `Failed to create forwarding address: ${forwardResult.error}`,
      step: "create_forwarding",
    });
  }

  // Map action names to Gmail API disposition values
  const dispositionMap: Record<string, string> = {
    keep: "leaveInInbox",
    archive: "archive",
    trash: "trash",
    markRead: "markRead",
  };

  // Step 2: Enable auto-forwarding
  const enableResult = await gws([
    "gmail",
    "users",
    "settings",
    "updateAutoForwarding",
    `--userId=${sourceUser}`,
    `--enabled=true`,
    `--emailAddress=${targetUser}`,
    `--disposition=${dispositionMap[action] || "leaveInInbox"}`,
  ]);

  return NextResponse.json({
    success: enableResult.success,
    data: {
      forwardingAddress: forwardResult.data,
      autoForwarding: enableResult.data,
    },
    error: enableResult.success ? undefined : enableResult.error,
  });
}
