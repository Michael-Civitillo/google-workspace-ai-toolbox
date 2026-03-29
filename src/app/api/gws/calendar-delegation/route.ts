import { NextRequest, NextResponse } from "next/server";
import { gws } from "@/lib/gws";

/**
 * List calendar ACL rules (delegates) for a user.
 * GET /api/gws/calendar-delegation?calendarId=user@domain.com
 */
export async function GET(request: NextRequest) {
  const calendarId = request.nextUrl.searchParams.get("calendarId");

  if (!calendarId) {
    return NextResponse.json(
      { error: "calendarId parameter is required" },
      { status: 400 }
    );
  }

  const result = await gws([
    "calendar",
    "acl",
    "list",
    `--calendarId=${calendarId}`,
  ]);

  return NextResponse.json(result);
}

/**
 * Add a calendar delegate (ACL rule).
 * POST /api/gws/calendar-delegation
 * Body: { calendarId: string, delegateEmail: string, role: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { calendarId, delegateEmail, role } = body;

  if (!calendarId || !delegateEmail || !role) {
    return NextResponse.json(
      { error: "calendarId, delegateEmail, and role are required" },
      { status: 400 }
    );
  }

  const result = await gws([
    "calendar",
    "acl",
    "insert",
    `--calendarId=${calendarId}`,
    `--role=${role}`,
    `--scope.type=user`,
    `--scope.value=${delegateEmail}`,
  ]);

  return NextResponse.json(result);
}

/**
 * Remove a calendar delegate (ACL rule).
 * DELETE /api/gws/calendar-delegation
 * Body: { calendarId: string, ruleId: string }
 */
export async function DELETE(request: NextRequest) {
  const body = await request.json();
  const { calendarId, ruleId } = body;

  if (!calendarId || !ruleId) {
    return NextResponse.json(
      { error: "calendarId and ruleId are required" },
      { status: 400 }
    );
  }

  const result = await gws([
    "calendar",
    "acl",
    "delete",
    `--calendarId=${calendarId}`,
    `--ruleId=${ruleId}`,
  ]);

  return NextResponse.json(result);
}
