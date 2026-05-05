import { execFile } from "child_process";
import { promisify } from "util";
import type { NextRequest } from "next/server";
import { resolveTenant } from "./tenants-server";
import type { Tenant } from "./tenant-types";

const execFileAsync = promisify(execFile);

/**
 * Resolve the gws binary name for the current platform.
 *
 * On Windows, `npm install -g` creates a `.cmd` shim — Node's `execFile`
 * doesn't auto-resolve extensions like the shell does, so we must spell
 * it out. `GWS_BIN` env var lets the operator override (e.g. point at a
 * `gws.exe` binary or a non-PATH location).
 */
const GWS_BIN =
  process.env.GWS_BIN ||
  (process.platform === "win32" ? "gws.cmd" : "gws");

export interface GwsResult {
  success: boolean;
  data?: unknown;
  error?: string;
  raw?: string;
}

/**
 * Resolve which tenant a request is targeting.
 *
 * Order of precedence:
 *   1. `x-tenant-id` request header
 *   2. `tenantId` query param
 *   3. `tenantId` field on the JSON body (already-parsed copy passed in by caller)
 *   4. persisted active tenant (legacy / bootstrap fallback)
 *
 * Throws if a tenantId is supplied but doesn't match a known tenant — we must
 * never silently fall back to "whatever's active" when the client thought it
 * was targeting something specific.
 */
export function tenantFromRequest(
  request: NextRequest,
  body?: Record<string, unknown> | null
): Tenant | null {
  const headerId = request.headers.get("x-tenant-id");
  const queryId = request.nextUrl.searchParams.get("tenantId");
  const bodyId =
    body && typeof body.tenantId === "string" ? body.tenantId : null;
  const id = headerId || queryId || bodyId || null;
  return resolveTenant(id);
}

/**
 * Execute a gws CLI command using the supplied tenant's credentials.
 */
export async function gws(
  args: string[],
  tenant: Tenant | null
): Promise<GwsResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (tenant?.credentialsFile) {
    env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = tenant.credentialsFile;
  }

  try {
    const { stdout, stderr } = await execFileAsync(GWS_BIN, args, {
      timeout: 30000,
      env,
    });

    if (stderr && !stdout) {
      return { success: false, error: stderr.trim() };
    }

    try {
      const data = JSON.parse(stdout);
      return { success: true, data };
    } catch {
      return { success: true, raw: stdout.trim() };
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error executing gws";
    return { success: false, error: message };
  }
}

/**
 * Check if gws CLI is installed and authenticated.
 */
export async function checkGwsStatus(): Promise<{
  installed: boolean;
  version?: string;
  authenticated: boolean;
}> {
  try {
    const { stdout } = await execFileAsync(GWS_BIN, ["--version"], {
      timeout: 5000,
    });
    const version = stdout.trim();

    try {
      await execFileAsync(GWS_BIN, ["auth", "export"], { timeout: 5000 });
      return { installed: true, version, authenticated: true };
    } catch {
      return { installed: true, version, authenticated: false };
    }
  } catch {
    return { installed: false, authenticated: false };
  }
}
