import { NextRequest, NextResponse } from "next/server";
import { getAppConfig, setUpdateCheck } from "@/lib/app-config";
import {
  clearUpdateCheck,
  latestRelease,
  RELEASES_PAGE,
  runningVersion,
  type UpdateCheckResult,
} from "@/lib/update-check";
import { audit } from "@/lib/audit";
import { actorFromRequest } from "@/lib/session";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

/**
 * The optional update check.
 *
 * GET  /api/config/update
 *        Whether the check is on, the version running and, when it is on,
 *        the newest release. While the setting is off this makes no request
 *        to anyone and says only what is running.
 * POST /api/config/update  { enabled?: boolean, check?: true }
 *        Turn the check on or off, and/or ask again now.
 */
const MAX_BODY_BYTES = 1024;

function status(enabled: boolean, result: UpdateCheckResult | null) {
  return {
    enabled,
    current: runningVersion(),
    latest: result?.latest ?? null,
    updateAvailable: result?.updateAvailable ?? false,
    url: result?.url ?? RELEASES_PAGE,
    checkedAt: result?.checkedAt ?? null,
    error: result?.error ?? null,
  };
}

const noStore = { headers: { "cache-control": "no-store" } };

export async function GET() {
  try {
    const { updateCheck } = getAppConfig();
    const result = updateCheck ? await latestRelease() : null;
    return NextResponse.json({ success: true, data: status(updateCheck, result) }, noStore);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const actor = await actorFromRequest(request);
  const body = await readCappedJson(request, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ success: false, error: "Body too large" }, { status: 413 });
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { success: false, error: "enabled must be true or false" },
      { status: 400 }
    );
  }
  try {
    let enabled = getAppConfig().updateCheck;
    if (typeof body.enabled === "boolean" && body.enabled !== enabled) {
      enabled = (await setUpdateCheck(body.enabled)).updateCheck;
      if (!enabled) clearUpdateCheck();
      audit({
        action: "config.update_check",
        tenantId: null,
        tenantName: null,
        params: { enabled },
        outcome: "success",
        actor,
      });
    }
    // Asking now needs the setting on: "check" never overrides "off".
    const result = enabled
      ? await latestRelease({ force: body.check === true || body.enabled === true })
      : null;
    return NextResponse.json({ success: true, data: status(enabled, result) }, noStore);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
