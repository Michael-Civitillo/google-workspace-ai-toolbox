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
import {
  discardDir,
  ensureExtracted,
  isExtracted,
  payloadHash,
  pruneOtherVersions,
  resetAppCache,
  type ExtractResult,
} from "./extract.ts";
import {
  findFreePort,
  findRunningInstance,
  generateInstanceToken,
  isPortAvailable,
  PORT_FALLBACK_SPAN,
  removeOwnLock,
  writeLock,
  type RunningInstance,
} from "./instance.ts";
import { acquireLock, LockTimeoutError, type HeldLock, type LockOptions } from "./lock.ts";
import { appDirFor, resolvePathsForProcess, type ResolvedPaths } from "./paths.ts";
import { isSea, loadPayload } from "./payload.ts";
import { openBrowser } from "./browser.ts";
import {
  applyServerEnv,
  installShutdown,
  maybeRunAsNode,
  startEmbeddedServer,
  waitUntilReady,
} from "./server.ts";
import { error, info, initLogFile, logFile, plain, warn } from "./log.ts";
import { isLoopbackHost, requestLaunchTicket, signInUrl } from "./signin.ts";
import {
  checkAppDir,
  clearFullCheckRequest,
  fullCheckRequested,
  parseManifest,
  requestFullCheck,
  type CheckMode,
  type ManifestEntry,
} from "./verify.ts";
import { shouldHoldWindow, waitForKey } from "./window.ts";

/** Replaced at build time by packaging/build-launcher.mjs. */
declare const __APP_VERSION__: string;
declare const __PAYLOAD_SHA256__: string;
/** JSON: [path, size, sha256] for every file in the payload. */
declare const __PAYLOAD_MANIFEST__: string;

let manifestEntries: ManifestEntry[] | null = null;
function manifest(): ManifestEntry[] {
  manifestEntries ??= parseManifest(__PAYLOAD_MANIFEST__);
  return manifestEntries;
}

/**
 * Load the embedded archive, check it is the one this launcher was built
 * with, and unpack it. Scoped to a function so the archive bytes are
 * unreachable — and collectable — the moment extraction finishes.
 */
function extractVerifiedPayload(appDir: string): ExtractResult {
  const payload = loadPayload();
  const actual = payloadHash(payload);
  if (actual !== __PAYLOAD_SHA256__) {
    throw new Error(
      `the application payload does not match this launcher ` +
        `(expected ${__PAYLOAD_SHA256__.slice(0, 12)}, found ${actual.slice(0, 12)}). ` +
        `Run "npm run package" to rebuild both together.`
    );
  }
  return ensureExtracted(payload, appDir);
}

const APP_TITLE = "Google Workspace Open Admin";
const DEFAULT_HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 60_000;

/** One start at a time per data folder (see run). */
const STARTUP_LOCK = "startup.lock";
/** One unpack or clean-up at a time per application folder. */
const APP_LOCK = "open-admin.lock";
const STARTUP_WAIT_MS = 3 * 60_000;
const APP_LOCK_WAIT_MS = 5 * 60_000;

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_PORT_BUSY = 3;
const EXIT_EXTRACT_FAILED = 4;
const EXIT_NOT_READY = 5;
const EXIT_STARTING_ELSEWHERE = 6;

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
  const shown = isLoopbackHost(host) ? "localhost" : host;
  return `http://${shown}:${port}`;
}

/**
 * Open the browser, signed in when that is possible.
 *
 * With automatic sign-in the launcher trades the password it holds for a
 * one-time ticket and opens the browser on the URL that redeems it. If the
 * server won't issue one (single sign-on is enforced, the saved password is
 * out of date, the request fails) the browser opens on the ordinary page and
 * the person signs in as before. Returns whether a ticket was used.
 */
async function openSignedIn(
  host: string,
  port: number,
  password: string,
  autoSignIn: boolean
): Promise<boolean> {
  const url = browsableUrl(host, port);
  const ticket = autoSignIn ? await requestLaunchTicket(host, port, password, url) : null;
  openBrowser(signInUrl(url, ticket));
  return ticket !== null;
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
  port: number,
  autoSignIn: boolean
): Promise<ResolvedSettings> {
  let dirty = args.port !== null && args.port !== stored.port;

  let sessionSecret = stored.sessionSecret ?? "";
  if (!sessionSecret) {
    sessionSecret = generateSessionSecret();
    dirty = true;
  }

  let password = args.password ?? process.env.APP_PASSWORD ?? stored.password ?? "";

  if (!password && autoSignIn && !args.setPassword) {
    // Nobody is going to type this: the launcher signs the browser in itself.
    // It still has to exist, because it is what the launcher proves itself
    // with and what any other browser would need.
    password = generatePassword();
    dirty = true;
    info(
      "A sign-in password was generated and saved in launcher.json in the data " +
        "folder. You only need it to sign in from another browser: run with " +
        "--set-password to choose your own."
    );
  } else if (args.setPassword || !password) {
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
 * Hold the application folder's lock while `work` runs: unpacking, repairing
 * and clean-up never overlap with another launch doing the same.
 */
async function withAppLock<T>(
  appRoot: string,
  work: () => T,
  options: LockOptions = {}
): Promise<T> {
  fs.mkdirSync(appRoot, { recursive: true });
  const lock = await acquireLock(path.join(appRoot, APP_LOCK), {
    waitMs: APP_LOCK_WAIT_MS,
    onWait: (owner) =>
      info(
        `Another copy of Open Admin${owner ? ` (process ${owner.pid})` : ""} is ` +
          `unpacking the application; waiting for it to finish ...`
      ),
    ...options,
  });
  try {
    return work();
  } finally {
    lock.release();
  }
}

/** Unpack a fresh copy into `appDir` and say so. */
function unpackFresh(appDir: string): string {
  const result = extractVerifiedPayload(appDir);
  if (result.extracted) {
    info(
      `Unpacked ${result.fileCount.toLocaleString("en-US")} application files ` +
        `in ${(result.elapsedMs / 1000).toFixed(1)}s.`
    );
  }
  return result.appDir;
}

/**
 * Make sure a usable copy of this version is unpacked, repairing a damaged or
 * altered one. The app directory is keyed by the payload hash baked in at
 * build time, so a launch that finds it already extracted never touches the
 * embedded archive: no copy out of the executable, no hashing of it, nothing
 * resident afterwards. What is in the folder is checked against the manifest
 * baked in beside that hash instead (verify.ts): every file read and hashed
 * when `mode` is "full", present at the right size otherwise. A missing file
 * is what antivirus quarantine or a half-finished clean-up leaves behind, and
 * it used to stop every start with "Fatal". Called with the application
 * folder's lock held.
 */
function prepareAppDir(appDir: string, appRoot: string, reset: boolean, mode: CheckMode): string {
  if (reset) {
    info("Clearing extracted application files (--reset-app-cache).");
    resetAppCache(appRoot);
  }
  if (isExtracted(appDir)) {
    const thorough = mode === "full" || fullCheckRequested(appDir);
    const startedAt = Date.now();
    const problem = checkAppDir(appDir, manifest(), thorough ? "full" : "quick");
    if (!problem) {
      if (thorough) {
        info(
          `Checked ${manifest().length.toLocaleString("en-US")} application files against ` +
            `this program in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`
        );
        clearFullCheckRequest(appDir);
      }
      return appDir;
    }
    warn(
      `The unpacked application in ${appDir} is damaged or has been changed ` +
        `(${problem}). Unpacking a fresh copy ...`
    );
    if (!discardDir(appDir)) {
      throw new Error(`the damaged copy in ${appDir} could not be removed`);
    }
  } else {
    // Said before the work, so a slow unpack isn't taken for a hang.
    info("Unpacking the application. This takes a moment the first time ...");
  }
  return unpackFresh(appDir);
}

interface StartedServer {
  host: string;
  port: number;
  config: LauncherConfig;
  appDir: string;
  running: RunningInstance;
}

/**
 * Everything from "is it already running?" to "the server is up and the lock
 * file says so", which must not interleave with another launch using the same
 * data folder. Returns an exit code when this run is over.
 */
async function startUnderLock(
  args: ParsedArgs,
  paths: ResolvedPaths,
  host: string,
  autoSignIn: boolean
): Promise<StartedServer | number> {
  const configFile = path.join(paths.dataDir, "launcher.json");
  const lockFile = path.join(paths.dataDir, "launcher.lock");
  const stored = readConfigFile(configFile);

  // Someone already started it: hand them the window rather than a port clash.
  // "Ours" means the server proved it knows the token in the lock file; only
  // then is the saved password sent anywhere.
  const running = await findRunningInstance(lockFile);
  if (running.kind === "ours") {
    const url = browsableUrl(running.host, running.port);
    info(`Already running at ${url} - opening it.`);
    if (!args.noBrowser) {
      // The other copy is the server; this one can still vouch for the person
      // with the saved password, so a second double-click also lands signed in.
      await openSignedIn(
        running.host,
        running.port,
        args.password ?? process.env.APP_PASSWORD ?? stored.password ?? "",
        autoSignIn && isLoopbackHost(running.host)
      );
    }
    return EXIT_OK;
  }
  if (running.kind === "unverified") {
    warn(
      `launcher.lock names process ${running.pid} on port ${running.port}, but what ` +
        `answers there could not prove it is the copy of Open Admin that wrote it (it ` +
        `may be another program, or an older version). Nothing is sent to it; ` +
        `starting a new copy instead.`
    );
  }

  // Before anything that could ask a question: nobody should be made to choose
  // a password only to be told afterwards that the port was taken.
  //
  // `preferredPort` is the one that is remembered; `port` is the one this run
  // listens on. They differ only when the preferred port is busy and nobody
  // asked for it by name: a double-click has no command line to add --port to,
  // so that run moves to the next free port rather than refusing to start.
  // The move is not saved, so the usual address comes back once it is free.
  const preferredPort = args.port ?? stored.port ?? DEFAULT_PORT;
  let port = preferredPort;
  if (!(await isPortAvailable(host, preferredPort))) {
    if (args.port !== null) {
      error(
        `Port ${preferredPort} on ${host} is already in use by another program. ` +
          `Pick a different --port, or leave the flag off to use the next free one.`
      );
      return EXIT_PORT_BUSY;
    }
    const fallback = await findFreePort(host, preferredPort + 1);
    if (fallback === null) {
      error(
        `Ports ${preferredPort} to ${preferredPort + PORT_FALLBACK_SPAN} on ${host} are all ` +
          `in use by other programs. Close one of them and start again.`
      );
      return EXIT_PORT_BUSY;
    }
    warn(
      `Port ${preferredPort} is in use by another program, so this run uses ` +
        `port ${fallback} instead.`
    );
    if (fs.existsSync(process.env.SSO_CONFIG_PATH ?? path.join(paths.dataDir, "sso.json"))) {
      warn(
        `Single sign-on is set up for the usual address and will not work on ` +
          `port ${fallback}: sign in with the password, or free port ` +
          `${preferredPort} and start again.`
      );
    }
    port = fallback;
  }

  const { config, dirty } = await resolveSettings(args, stored, preferredPort, autoSignIn);
  if (dirty) {
    try {
      writeConfigFile(configFile, config);
    } catch (e) {
      warn(`Could not save settings to ${configFile}: ${describe(e)}`);
    }
  }

  const wantedAppDir = appDirFor(paths.appRoot, __APP_VERSION__, __PAYLOAD_SHA256__);
  // Outside the per-user folder (portable mode, --root) other people may be
  // able to write where the application is unpacked: check every file.
  const checkMode: CheckMode = paths.defaultRoot ? "quick" : "full";
  let appDir: string;
  try {
    appDir = await withAppLock(paths.appRoot, () =>
      prepareAppDir(wantedAppDir, paths.appRoot, args.resetAppCache, checkMode)
    );
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      error(
        `Another copy of Open Admin${e.owner ? ` (process ${e.owner.pid})` : ""} has been ` +
          `unpacking the application for more than ${APP_LOCK_WAIT_MS / 60_000} minutes. ` +
          `Wait for it, or close it, then try again.`
      );
      return EXIT_EXTRACT_FAILED;
    }
    error(`Could not unpack the application into ${wantedAppDir}: ${describe(e)}`);
    error(
      "Check that the folder is writable and that antivirus software isn't " +
        "blocking it, then try again."
    );
    return EXIT_EXTRACT_FAILED;
  }

  // A new secret for every start: the server proves it knows it before a later
  // launch will send it the password (see findRunningInstance).
  const instanceToken = generateInstanceToken();

  // Register cleanup before the server can install handlers of its own.
  installShutdown(() => removeOwnLock(lockFile, instanceToken));

  applyServerEnv({
    appDir,
    dataDir: paths.dataDir,
    host,
    port,
    password: config.password,
    sessionSecret: config.sessionSecret,
    instanceToken,
  });

  const url = browsableUrl(host, port);
  info(`Starting the server on ${url} ...`);
  try {
    startEmbeddedServer(appDir);
  } catch (first) {
    // The server's code failed to load: a file damaged or removed since it was
    // unpacked. Unpack it again, once, rather than failing the same way on
    // every start.
    warn(`The application could not be loaded (${describe(first)}). Unpacking it again ...`);
    try {
      appDir = await withAppLock(paths.appRoot, () => {
        if (!discardDir(wantedAppDir)) {
          throw new Error(`the damaged copy in ${wantedAppDir} could not be removed`);
        }
        return unpackFresh(wantedAppDir);
      });
      startEmbeddedServer(appDir);
    } catch (second) {
      error(`The server could not be started: ${describe(second)}`);
      error(
        "If this keeps happening, antivirus software may be removing the " +
          `application's files: allow ${paths.appRoot} and try again.`
      );
      return EXIT_NOT_READY;
    }
  }

  // The server loads most of itself asynchronously, and exits the process if
  // that fails. If this process ends before the server is ready, the next
  // start reads and hashes every file rather than only counting them.
  let ready = false;
  const startedFrom = appDir;
  process.on("exit", (code) => {
    if (!ready && code !== 0) requestFullCheck(startedFrom);
  });

  try {
    await waitUntilReady(host, port, READY_TIMEOUT_MS);
  } catch (e) {
    error(`The server didn't finish starting: ${describe(e)}`);
    return EXIT_NOT_READY;
  }
  ready = true;

  writeLock(lockFile, {
    pid: process.pid,
    port,
    host,
    startedAt: new Date().toISOString(),
    token: instanceToken,
  });

  return { host, port, config, appDir, running };
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
  if (paths.portableTrigger) {
    const byMarker = path.basename(paths.portableTrigger) === "portable.txt";
    info(
      `Portable mode is on because ${paths.portableTrigger} exists: the application ` +
        `and its data are kept beside this program, in ${paths.root}.` +
        (byMarker ? " Delete portable.txt to keep them in your user profile instead." : "")
    );
  }

  const envFile = path.join(paths.dataDir, "launcher.env");
  const fromEnvFile = applyEnvFile(envFile);
  if (fromEnvFile.applied.length > 0) {
    info(`Loaded from launcher.env: ${fromEnvFile.applied.join(", ")}`);
  }
  if (fromEnvFile.refused.length > 0) {
    warn(
      `Ignored in launcher.env: ${fromEnvFile.refused.join(", ")}. Settings that turn off ` +
        `certificate checks or choose code to load or run are not accepted from that ` +
        `file; set them in the environment instead if you really need them.`
    );
  }

  const host = args.host ?? DEFAULT_HOST;
  // Signing the browser in automatically is for the person at this machine.
  // Bound to anything else, the app is being served to other people, and they
  // sign in like anyone else.
  const autoSignIn = !args.noAutoSignIn && isLoopbackHost(host);
  if (host !== DEFAULT_HOST) {
    warn(
      `Binding ${host} instead of loopback. Anyone who can reach this machine on ` +
        `the network can reach the app, over plain HTTP. Add the URL people will ` +
        `type to APP_ALLOWED_ORIGINS in launcher.env, or every sign-in is refused ` +
        `as cross-origin.`
    );
  }

  // One start at a time per data folder. Two double-clicks a moment apart used
  // to unpack into, and delete, the same folder at once; now the second waits
  // for the first to finish starting, and then finds it running.
  let startup: HeldLock;
  try {
    startup = await acquireLock(path.join(paths.dataDir, STARTUP_LOCK), {
      waitMs: STARTUP_WAIT_MS,
      onWait: (owner) =>
        info(
          `Another copy of Open Admin${owner ? ` (process ${owner.pid})` : ""} is ` +
            `starting; waiting for it to finish ...`
        ),
    });
  } catch (e) {
    if (!(e instanceof LockTimeoutError)) throw e;
    error(
      `Another copy of Open Admin${e.owner ? ` (process ${e.owner.pid})` : ""} has been ` +
        `starting for more than ${STARTUP_WAIT_MS / 60_000} minutes. Let it finish, or ` +
        `close it, then try again.`
    );
    return EXIT_STARTING_ELSEWHERE;
  }
  let started: StartedServer | number;
  try {
    started = await startUnderLock(args, paths, host, autoSignIn);
  } finally {
    startup.release();
  }
  if (typeof started === "number") return started;
  const { port, config } = started;

  const url = browsableUrl(host, port);
  plain("");
  info(`Ready: ${url}`);
  const opening = config.openBrowser && !args.noBrowser;
  const signedIn = opening
    ? await openSignedIn(host, port, config.password, autoSignIn)
    : false;
  plain(
    signedIn
      ? "Your browser is opening, already signed in."
      : "Sign in with the password you set."
  );
  plain("Keep this window open while you work. Closing it, or Ctrl+C, stops Open Admin.");
  plain("");

  // Clean up older versions last, once the person has their window: it is
  // the slowest part of an upgrade and nothing waits on it. Skipped when
  // another launch is busy in the folder, and when a copy that could not
  // prove itself may be an older version still running from its own folder.
  if (started.running.kind !== "unverified") {
    try {
      const pruned = await withAppLock(
        paths.appRoot,
        () => pruneOtherVersions(paths.appRoot, started.appDir),
        { waitMs: 0, onWait: () => {} }
      );
      if (pruned.length > 0) info(`Removed ${pruned.length} older application copies.`);
    } catch {
      // Next time.
    }
  }

  // Resolve with null: the server owns the process from here.
  return null;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Leave with `code`. When the start failed and this looks like a double-click
 * on Windows, the console window is about to vanish along with the only copy
 * of the explanation, so wait for a key first (see window.ts).
 */
async function finish(code: number, userArgCount: number): Promise<never> {
  const hold = shouldHoldWindow({
    platform: process.platform,
    packaged: isSea(),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    userArgCount,
    exitCode: code,
  });
  if (hold) {
    const log = logFile();
    plain("");
    plain(`${APP_TITLE} could not start. The reason is shown above.`);
    if (log) plain(`A copy is saved in ${log}`);
    plain("");
    plain("Press any key to close this window.");
    await waitForKey();
  }
  process.exit(code);
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
      // null: the server is up and owns the process from here.
      if (code !== null) return finish(code, userArgs.length);
    })
    .catch((e: unknown) => {
      error(`Fatal: ${describe(e)}`);
      return finish(1, userArgs.length);
    });
}
