import { exec } from "child_process";
import { promisify } from "util";
import { getActiveTenant } from "./tenants";

const execAsync = promisify(exec);

export interface GwsResult {
  success: boolean;
  data?: unknown;
  error?: string;
  raw?: string;
}

/**
 * Execute a gws CLI command and return parsed JSON output.
 */
export async function gws(args: string[]): Promise<GwsResult> {
  const command = `gws ${args.join(" ")}`;

  const activeTenant = getActiveTenant();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (activeTenant?.credentialsFile) {
    env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = activeTenant.credentialsFile;
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
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
    const { stdout } = await execAsync("gws --version", { timeout: 5000 });
    const version = stdout.trim();

    // Try a simple auth check
    try {
      await execAsync("gws auth export", { timeout: 5000 });
      return { installed: true, version, authenticated: true };
    } catch {
      return { installed: true, version, authenticated: false };
    }
  } catch {
    return { installed: false, authenticated: false };
  }
}
