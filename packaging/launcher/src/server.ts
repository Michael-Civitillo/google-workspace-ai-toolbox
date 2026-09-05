import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { probeHttp } from "./instance.ts";

/**
 * Starting the bundled Next.js server inside this process, and the environment
 * contract it runs under.
 */

export interface ServerEnvOptions {
  appDir: string;
  dataDir: string;
  host: string;
  port: number;
  password: string;
  sessionSecret: string;
}

/**
 * Environment the embedded server sees.
 *
 * Two entries carry more weight than they look:
 *
 *   HOSTNAME  is both the bind address and, in a standalone build, the host
 *             Next treats as canonical. The app's CSRF check compares the
 *             browser's Origin against it, so this value decides which URL
 *             actually works - see the launcher's ready message.
 *
 *   OPEN_ADMIN_DATA_DIR  moves tenants.json, sso.json, app-config.json, the
 *             audit log and imported keys out of the extracted application
 *             directory, which is versioned and deleted on upgrade.
 *
 * AUDIT_LOG_PATH and SSO_CONFIG_PATH are set only when the operator has not,
 * since those are long-standing app-level overrides someone may rely on.
 */
export function applyServerEnv(options: ServerEnvOptions): void {
  process.env.NODE_ENV = "production";
  process.env.PORT = String(options.port);
  process.env.HOSTNAME = options.host;
  process.env.APP_PASSWORD = options.password;
  process.env.APP_SESSION_SECRET ??= options.sessionSecret;
  process.env.OPEN_ADMIN_DATA_DIR = options.dataDir;
  process.env.AUDIT_LOG_PATH ??= path.join(options.dataDir, "audit.log");
  process.env.SSO_CONFIG_PATH ??= path.join(options.dataDir, "sso.json");
  process.env.OPEN_ADMIN_PACKAGED = "1";
  process.env.NEXT_TELEMETRY_DISABLED = "1";
}

/**
 * Run the Next.js standalone entry point in this process. It binds the port
 * itself; readiness is confirmed separately by polling.
 */
export function startEmbeddedServer(appDir: string): void {
  const serverJs = path.join(appDir, "server.js");
  if (!fs.existsSync(serverJs)) {
    throw new Error(`bundled application is incomplete: ${serverJs} is missing`);
  }
  // Resolve from the application directory so its own node_modules are used.
  createRequire(serverJs)(serverJs);
}

/** Poll the login page until the server answers, or give up. */
export async function waitUntilReady(
  host: string,
  port: number,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await probeHttp(host, port, "/login", 2000);
    if (status !== null) return status;
    if (Date.now() > deadline) {
      throw new Error(`server did not answer on ${host}:${port} within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Install shutdown handling before the server starts, so this runs ahead of
 * Next's own signal handlers (which exit the process on their own schedule).
 * `onShutdown` must be synchronous - it may be the last thing that runs.
 */
export function installShutdown(onShutdown: () => void): void {
  let shuttingDown = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    onShutdown();
    console.log(`\nStopping (${signal}). Goodbye.`);
    // Give Next a moment to close listeners; exit regardless so a stuck
    // connection can't leave a console window open forever.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
  // Backstop for every other way out, including Next's own process.exit().
  process.on("exit", () => onShutdown());
}

/**
 * Compatibility shim: behave like plain `node script.js` when something
 * re-executes this binary with a script path. Nothing in the production Next
 * server does that today, but in a single-file build `process.execPath` is
 * this executable, so any future dependency that shells out to Node would
 * otherwise get a web server instead of its script.
 *
 * Takes the user arguments (argv minus the two leading path slots).
 */
export function maybeRunAsNode(userArgs: string[]): boolean {
  const candidate = userArgs[0];
  if (!candidate || !/\.[cm]?js$/.test(candidate)) return false;
  if (!fs.existsSync(candidate)) return false;
  createRequire(path.resolve(candidate))(path.resolve(candidate));
  return true;
}
