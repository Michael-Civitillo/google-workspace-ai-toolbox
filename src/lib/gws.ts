import { execFile } from "child_process";
import { promisify } from "util";
import type { NextRequest } from "next/server";
import { resolveTenant } from "./tenants-server";
import type { Tenant } from "./tenant-types";

const execFileAsync = promisify(execFile);

const IS_WINDOWS = process.platform === "win32";

/**
 * Resolve the gws binary name for the current platform.
 *
 * On Windows, `npm install -g` creates a `.cmd` shim — Node's `execFile`
 * doesn't auto-resolve extensions like the shell does, so we must spell
 * it out. `GWS_BIN` env var lets the operator override (e.g. point at a
 * `gws.exe` binary or a non-PATH location).
 */
const GWS_BIN =
  process.env.GWS_BIN || (IS_WINDOWS ? "gws.cmd" : "gws");

/**
 * Run gws via execFile, with the Windows-specific quirks taken care of.
 *
 * Two Windows landmines this navigates:
 *
 *   1. CVE-2024-27980 (Node 18.20.2+, 20.12.2+, 21.7.3+): `child_process`
 *      now refuses to invoke `.cmd` / `.bat` files unless `shell: true` is
 *      set. The npm-installed `gws` shim is `gws.cmd`, so without this we
 *      get EINVAL ("Executable invalid").
 *
 *   2. With `shell: true`, the args array is still escaped properly by
 *      Node, but the *binary path itself* is not quoted. If GWS_BIN points
 *      at a path with spaces (e.g. "C:\\Program Files\\..."), cmd.exe
 *      splits it on whitespace. We handle that by quoting before passing.
 */
function runGws(
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv }
) {
  if (IS_WINDOWS) {
    const file = GWS_BIN.includes(" ") ? `"${GWS_BIN}"` : GWS_BIN;
    return execFileAsync(file, args, { ...options, shell: true });
  }
  return execFileAsync(GWS_BIN, args, options);
}

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
    const { stdout, stderr } = await runGws(args, {
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
 *
 * On failure we surface the resolved binary name and the error message so
 * the operator can debug PATH / shim / permissions issues from the Setup
 * page without having to spelunk through server logs.
 */
export async function checkGwsStatus(): Promise<{
  installed: boolean;
  version?: string;
  authenticated: boolean;
  bin?: string;
  error?: string;
}> {
  try {
    const { stdout } = await runGws(["--version"], { timeout: 5000 });
    const version = stdout.trim();

    try {
      await runGws(["auth", "export"], { timeout: 5000 });
      return { installed: true, version, authenticated: true, bin: GWS_BIN };
    } catch {
      return { installed: true, version, authenticated: false, bin: GWS_BIN };
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { installed: false, authenticated: false, bin: GWS_BIN, error };
  }
}
