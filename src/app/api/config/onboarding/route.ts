import { NextRequest, NextResponse } from "next/server";
import { sessionRefusal } from "@/lib/route-guard";
import { setOnboardingCompleted } from "@/lib/app-config";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";
import { errorStatusFor } from "@/lib/api-errors";
import { audit } from "@/lib/audit";
import { actorFromRequest } from "@/lib/session";

const MAX_BODY_BYTES = 1024;

/**
 * Mark the first-launch wizard as completed (or reset it with
 * {completed:false} to make the wizard offer itself again).
 */
export async function POST(req: NextRequest) {
  const noSession = await sessionRefusal(req);
  if (noSession) return noSession;
  const actor = await actorFromRequest(req);
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  const completed = body.completed !== false;
  try {
    const config = await setOnboardingCompleted(completed);
    // Resetting the wizard changes what every operator sees next: on record.
    audit({
      action: "config.onboarding",
      tenantId: null,
      tenantName: null,
      params: { completed },
      outcome: "success",
      actor,
    });
    return NextResponse.json({
      onboardingCompletedAt: config.onboardingCompletedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    audit({
      action: "config.onboarding",
      tenantId: null,
      tenantName: null,
      params: { completed },
      outcome: "error",
      error: message,
      actor,
    });
    return NextResponse.json({ error: message }, { status: errorStatusFor(error) });
  }
}
