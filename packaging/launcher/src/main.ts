import fs from "node:fs";
import path from "node:path";

import { parseArgs, usage, type ParsedArgs } from "./args.ts";
import {
  applyEnvFile,
  DEFAULT_PORT,
  CONFIG_VERSION,
  generatePassword,
  generateSessionSecret,
  promptForPassword,
  readConfigFile,
  writeConfigFile,
  type LauncherConfig,
} from "./config.ts";
import { ensureExtracted, payloadHash, pruneOtherVersions } from "./extract.ts";
import {
  isPortFree,
  isProcessAlive,
  probeHttp,
  readLock,
  removeLock,
  writeLock,
} from "./instance.ts";
import { appDirFor, resolvePathsForProcess } from "./paths.ts";
import { isSea, loadPayload } from "./payload.ts";
import { openBrowser } from "./browser.ts";
import {
  applyServerEnv,
  installShutdown,
  maybeRunAsNode,
  startEmbeddedServer,
  waitUntilReady,
} from "./server.ts";
import { error, info, initLogFile, plain, warn } from "./log.ts";

/** Replaced at build time by packaging/build-launcher.mjs. */
declare const __APP_VERSION__: string;
declare const __PAYLOAD_SHA256__: string;

const APP_TITLE = "Google Workspace Open Admin";
const DEFAULT_HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 60_000;

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_PORT_BUSY = 3;
const EXIT_EXTRACT_FAILED = 4;
const EXIT_NOT_READY = 5;

/**
 * A loopback URL must be spelled `localhost`, not `127.0.0.1`.
 *
 * The standalone Next.js server treats the address it bound as the canonical
 * host and normalises every loopback spelling to `localhost`; the app's CSRF
 * check compares the browser's Origin against that. The app now also accepts
 * the numeric form, but `localhost` is additionally what browsers treat as a
 * trustworthy origin, which is what lets the Secure session cookie work over
 * plain HTTP. So: bind the address, advertise the name.
 */
function browsableUrl(host: string, port: number): string {
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const shown = isLoopback ? "localhost" : host;
  return `http://${shown}:${port}`;
}

function printVersion(): void {
  plain(`${APP_TITLE} ${__APP_VERSION__}`);
  plain(`  application payload  ${__PAYLOAD_SHA256__.slice(0, 16)}`);
  plain(`  node runtime         ${process.version}`);
  plain(`  packaged executable  ${isSea() ? "yes" : "no"}`);
}

interface ResolvedSettings {
  config: LauncherConfig;
  /** True when launcher.json needs writing back. */
  dirty: boolean;
}

/**
 * Merge, lowest priority first: stored config, launcher.env, the real
 * environment, then command-line flags. Prompt only when that leaves no
 * password at all.
 */
async function resolveSettings(
  args: ParsedArgs,
  stored: Partial<LauncherConfig>,
  port: number
): Promise<ResolvedSettings> {
  let dirty = args.port !== null && args.port !== stored.port;

  let sessionSecret = stored.sessionSecret ?? "";
  if (!sessionSecret) {
    sessionSecret = generateSessionSecret();
    dirty = true;
  }

  let password = args.password ?? process.env.APP_PASSWORD ?? stored.password ?? "";

  if (args.setPassword || !password) {
    if (args.setPassword) {
      plain("");
      plain("Choose the password you'll use to sign in to the web interface.");
    } else {
      plain("");
      plain(`First run. Choose the password you'll use to sign in (12+ characters).`);
    }
    const result = await promptForPassword(plain).catch(() => ({
      password: generatePassword(),
      generated: true,
    }));
    password = result.password;
    dirty = true;
    if (result.generated) {
      plain("");
      warn("No terminal to prompt on, so a password was generated for you:");
      plain(`    ${password}`);
      plain("  Write it down - it is stored in launcher.json and shown only once.");
      plain("");
    } else {
      plain("Saved. Change it any time with --set-password.");
    }
  }

  const config: LauncherConfig = {
    version: CONFIG_VERSION,
    port,
    password,
    sessionSecret,
    // --no-browser is a choice about this run, not a setting to remember.
    openBrowser: stored.openBrowser ?? true,
  };
  if (stored.password !== password || stored.version !== CONFIG_VERSION) dirty = true;

  return { config, dirty };
}

/**
 * Is one of our servers already up? The lock file names the port it took,
 * which is what we hand back - a second launch should open the window the
 * first one is serving, whatever port that turned out to be.
 *
 * Both halves are needed: a stale lock file (crash, power loss, recycled pid)
 * must not stop a legitimate start, so a live pid alone isn't enough.
 */
async function findRunningInstance(
  lockFile: string
): Promise<{ host: string; port: number } | null> {
  const lock = readLock(lockFile);
  if (!lock || !isProcessAlive(lock.pid)) return null;
  const status = await probeHttp(lock.host, lock.port, "/login", 2000);
  if (status === null) return null;
  return { host: lock.host, port: lock.port };
}

async function run(userArgs: string[]): Promise<number | null> {
  const parsed = parseArgs(userArgs);
  if (parsed.error || !parsed.args) {
    console.error(`Error: ${parsed.error}`);
    console.error("");
    console.error(usage(path.basename(process.execPath)));
    return EXIT_USAGE;
  }
  const args = parsed.args;

  if (args.help) {
    plain(usage(path.basename(process.execPath)));
    return EXIT_OK;
  }
  if (args.version) {
    printVersion();
    return EXIT_OK;
  }

  const paths = resolvePathsForProcess(args.root, args.dataDir);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  initLogFile(path.join(paths.dataDir, "logs"));

  plain("");
  plain(`${APP_TITLE} ${__APP_VERSION__}  (Node ${process.version})`);
  info(`Data folder: ${paths.dataDir}${paths.portable ? "  (portable mode)" : ""}`);

  const applied = applyEnvFile(path.join(paths.dataDir, "launcher.env"));
  if (applied.length > 0) info(`Loaded from launcher.env: ${applied.join(", ")}`);

  const host = args.host ?? DEFAULT_HOST;
  if (host !== DEFAULT_HOST) {
    warn(
      `Binding ${host} instead of loopback. Anyone who can reach this machine on ` +
        `the network can reach the app, over plain HTTP. Browsers must use exactly ` +
        `"${host}" in the address bar.`
    );
  }

  const configFile = path.join(paths.dataDir, "launcher.json");
  const lockFile = path.join(paths.dataDir, "launcher.lock");
  const stored = readConfigFile(configFile);

  // Someone already started it: hand them the window rather than a port clash.
  const running = await findRunningInstance(lockFile);
  if (running) {
    const url = browsableUrl(running.host, running.port);
    info(`Already running at ${url} - opening it.`);
    if (!args.noBrowser) openBrowser(url);
    return EXIT_OK;
  }
  removeLock(lockFile);

  // Before anything that could ask a question: nobody should be made to choose
  // a password only to be told afterwards that the port was taken.
  const port = args.port ?? stored.port ?? DEFAULT_PORT;
  if (!(await isPortFree(host, port))) {
    error(
      `Port ${port} on ${host} is already in use by another program. ` +
        `Start with --port 3001 (or any free port) instead.`
    );
    return EXIT_PORT_BUSY;
  }

  const { config, dirty } = await resolveSettings(args, stored, port);
  if (dirty) {
    try {
      writeConfigFile(configFile, config);
    } catch (e) {
      warn(`Could not save settings to ${configFile}: ${describe(e)}`);
    }
  }

  // Unpack the bundled application.
  const payload = loadPayload();
  const appDir = appDirFor(paths.appRoot, __APP_VERSION__, payloadHash(payload));
  if (args.resetAppCache) {
    info("Clearing extracted application files (--reset-app-cache).");
    fs.rmSync(paths.appRoot, { recursive: true, force: true });
  }
  let extractedAppDir: string;
  try {
    const result = ensureExtracted(payload, appDir);
    extractedAppDir = result.appDir;
    if (result.extracted) {
      info(
        `Unpacked ${result.fileCount.toLocaleString("en-US")} application files ` +
          `in ${(result.elapsedMs / 1000).toFixed(1)}s.`
      );
    }
  } catch (e) {
    error(`Could not unpack the application into ${appDir}: ${describe(e)}`);
    error(
      "Check that the folder is writable and that antivirus software isn't " +
        "blocking it, then try again."
    );
    return EXIT_EXTRACT_FAILED;
  }

  // Register cleanup before the server can install handlers of its own.
  installShutdown(() => removeLock(lockFile));

  applyServerEnv({
    appDir: extractedAppDir,
    dataDir: paths.dataDir,
    host,
    port: config.port,
    password: config.password,
    sessionSecret: config.sessionSecret,
  });

  const url = browsableUrl(host, config.port);
  info(`Starting the server on ${url} ...`);
  startEmbeddedServer(extractedAppDir);

  try {
    await waitUntilReady(host, config.port, READY_TIMEOUT_MS);
  } catch (e) {
    error(`The server didn't finish starting: ${describe(e)}`);
    return EXIT_NOT_READY;
  }

  writeLock(lockFile, {
    pid: process.pid,
    port: config.port,
    host,
    startedAt: new Date().toISOString(),
  });

  const pruned = pruneOtherVersions(paths.appRoot, extractedAppDir);
  if (pruned.length > 0) info(`Removed ${pruned.length} older application copies.`);

  plain("");
  info(`Ready: ${url}`);
  plain("Sign in with the password you set. Press Ctrl+C to stop.");
  plain("");

  if (config.openBrowser && !args.noBrowser) openBrowser(url);

  // Resolve with null: the server owns the process from here.
  return null;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A packaged single-file build has the same argv shape as `node script.js`:
 * [resolved executable, invoked path, ...user arguments]. Verified against a
 * real single-executable build - do not "fix" this to slice(1).
 */
const userArgs = process.argv.slice(2);

// Behave like plain `node script.js` if something re-executes this binary
// with a script path (see server.ts).
if (!maybeRunAsNode(userArgs)) {
  run(userArgs)
    .then((code) => {
      if (code !== null) process.exit(code);
    })
    .catch((e: unknown) => {
      error(`Fatal: ${describe(e)}`);
      process.exit(1);
    });
}
