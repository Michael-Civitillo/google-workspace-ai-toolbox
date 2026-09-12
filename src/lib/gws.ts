import { execFile } from "child_process";
import { promisify } from "util";
import type { NextRequest } from "next/server";
import { getTenants, resolveTenant } from "./tenants-server";
import type { Tenant } from "./tenant-types";
import { ValidationError } from "./validate";

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
 *   2. With `shell: true`, Node does NOT escape the args array — they are
 *      concatenated into a command line and re-parsed by cmd.exe. The binary
 *      path is likewise unquoted. We wrap an unquoted GWS_BIN in double quotes
 *      so a path like `C:\Program Files\gws.cmd` is passed as a single token,
 *      and we reject any argument containing shell metacharacters (see
 *      assertSafeArg) so nothing can break out of the intended command.
 *      Operators who already pre-quote `GWS_BIN` are left alone (no double-wrap).
 */
function quoteForWindowsShell(bin: string): string {
  if (bin.startsWith('"') && bin.endsWith('"') && bin.length >= 2) return bin;
  // cmd.exe doubles `"` to escape it inside a quoted token.
  return `"${bin.replace(/"/g, '""')}"`;
}

// On the Windows shell path the args are re-parsed by cmd.exe, so any
// metacharacter in an argument could break out of the command. Refuse them
// rather than attempt to escape every cmd.exe quirk. The CLI's real arguments
// are plain flags/identifiers, so this never rejects a legitimate call.
const WINDOWS_SHELL_UNSAFE = /[&|<>^"`%\r\n]/;

function assertSafeArg(arg: string): void {
  if (WINDOWS_SHELL_UNSAFE.test(arg)) {
    throw new Error("gws argument contains illegal shell characters");
  }
}

// The CLI inherits the environment it needs (PATH, HOME, proxy settings, its
// own GOOGLE_WORKSPACE_* variables) but never this app's secrets.
const SECRET_ENV_PREFIXES = ["APP_", "GOOGLE_GENERATIVE_AI_", "CLOUDFLARE_"];

function childEnv(
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  return { ...env, ...overrides } as NodeJS.ProcessEnv;
}

function runGws(
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv }
) {
  const withEnv = { ...options, env: options.env ?? childEnv() };
  if (IS_WINDOWS) {
    for (const a of args) assertSafeArg(a);
    return execFileAsync(quoteForWindowsShell(GWS_BIN), args, {
      ...withEnv,
      shell: true,
    });
  }
  return execFileAsync(GWS_BIN, args, withEnv);
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
  if (!id && request.method !== "GET" && request.method !== "HEAD") {
    // A mutation that names no tenant would run against whichever tenant was
    // activated last — global state any tab or operator can flip. With a
    // single tenant there is nothing to get wrong; with several, refuse.
    if (getTenants().length > 1) {
      throw new ValidationError(
        "Select a tenant first — this request did not say which tenant it targets."
      );
    }
  }
  return resolveTenant(id);
}

/**
 * Execute a gws CLI command using the supplied tenant's credentials.
 */
export async function gws(
  args: string[],
  tenant: Tenant | null
): Promise<GwsResult> {
  const env = childEnv(
    tenant?.credentialsFile
      ? { GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: tenant.credentialsFile }
      : {}
  );

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
export interface GwsStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  bin?: string;
  error?: string;
}

async function probeGwsStatus(): Promise<GwsStatus> {
  try {
    const { stdout } = await runGws(["--version"], { timeout: 5000 });
    const version = stdout.trim();

    try {
      // The CLI has no read-only "am I signed in" command, so exporting the
      // credentials (to a pipe that is discarded) is the auth probe.
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

// The probe spawns two processes; the dashboard and setup pages ask for it on
// every visit. Cache the answer briefly and coalesce concurrent probes — the
// "Re-check" buttons pass `fresh` to bypass the cache.
const STATUS_CACHE_TTL_MS = 30_000;
let statusCache: { at: number; value: GwsStatus } | null = null;
let statusInFlight: Promise<GwsStatus> | null = null;

export async function checkGwsStatus(
  opts: { fresh?: boolean } = {}
): Promise<GwsStatus> {
  if (!opts.fresh) {
    if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_TTL_MS) {
      return statusCache.value;
    }
    if (statusInFlight) return statusInFlight;
  }
  const probe = probeGwsStatus()
    .then((value) => {
      statusCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (statusInFlight === probe) statusInFlight = null;
    });
  statusInFlight = probe;
  return probe;
}
