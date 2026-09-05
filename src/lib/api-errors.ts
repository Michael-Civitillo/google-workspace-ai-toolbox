import { NextResponse } from "next/server";
import { ValidationError } from "./validate";
import { TenantNotFoundError } from "./tenants-server";
import { googleHttpStatus } from "./admin-sdk";

/**
 * Map a thrown error to the HTTP status an API route should answer with.
 *
 *   - TenantNotFoundError → 404 (a stale tenant id from the sidebar pin)
 *   - ValidationError     → 400 (the request itself was malformed)
 *   - a Google API rejection keeps its own 404 / 409 (unknown user or calendar,
 *     already exists) and is otherwise reported as 502: the failure happened
 *     upstream, and monitors keying on 5xx should be able to tell an
 *     application bug (500) from Google saying no.
 *   - anything else       → 500
 */
export function errorStatusFor(e: unknown): number {
  if (e instanceof TenantNotFoundError) return 404;
  if (e instanceof ValidationError) return 400;
  const upstream = googleHttpStatus(e);
  if (upstream !== null) {
    return upstream === 404 || upstream === 409 ? upstream : 502;
  }
  return 500;
}

/** The standard `{ success: false, error }` failure body with a matching status. */
export function errorResponse(
  e: unknown,
  fallback = "Unexpected error"
): NextResponse {
  const message = e instanceof Error ? e.message : fallback;
  return NextResponse.json(
    { success: false, error: message },
    { status: errorStatusFor(e) }
  );
}
