import { NextRequest, NextResponse } from "next/server";
import { gws } from "@/lib/gws";

/**
 * List email delegates for a user.
 * GET /api/gws/email-delegation?user=user@domain.com
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
    "settings",
    "delegates",
    "list",
    `--userId=${user}`,
  ]);

  return NextResponse.json(result);
}

/**
 * Add an email delegate.
 * POST /api/gws/email-delegation
 * Body: { user: string, delegate: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { user, delegate } = body;

  if (!user || !delegate) {
    return NextResponse.json(
      { error: "user and delegate are required" },
      { status: 400 }
    );
  }

  const result = await gws([
    "gmail",
    "users",
    "settings",
    "delegates",
    "create",
    `--userId=${user}`,
    `--delegateEmail=${delegate}`,
  ]);

  return NextResponse.json(result);
}

/**
 * Remove an email delegate.
 * DELETE /api/gws/email-delegation
 * Body: { user: string, delegate: string }
 */
export async function DELETE(request: NextRequest) {
  const body = await request.json();
  const { user, delegate } = body;

  if (!user || !delegate) {
    return NextResponse.json(
      { error: "user and delegate are required" },
      { status: 400 }
    );
  }

  const result = await gws([
    "gmail",
    "users",
    "settings",
    "delegates",
    "delete",
    `--userId=${user}`,
    `--delegateEmail=${delegate}`,
  ]);

  return NextResponse.json(result);
}
