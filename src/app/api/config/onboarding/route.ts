import { NextRequest, NextResponse } from "next/server";
import { setOnboardingCompleted } from "@/lib/app-config";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

const MAX_BODY_BYTES = 1024;

/**
 * Mark the first-launch wizard as completed (or reset it with
 * {completed:false} to make the wizard offer itself again).
 */
export async function POST(req: NextRequest) {
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  const completed = body.completed !== false;
  try {
    const config = await setOnboardingCompleted(completed);
    return NextResponse.json({
      onboardingCompletedAt: config.onboardingCompletedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
