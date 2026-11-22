// Start-up shared by everything in this folder: the stand-in for Google, the
// packaged app pointed at it, and a browser to drive the app with.
//
// Nothing in the app is replaced or mocked. It is started exactly as shipped,
// with three settings any install could have: an HTTPS proxy (which is the
// stand-in), one extra certificate authority to trust (the stand-in's), and a
// DNS server for the email authentication check. Its real Google client then
// opens real TLS connections to "admin.googleapis.com" and friends, and
// fake-google.mjs answers them.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where `npm run package:bin` (or `package:exe`) leaves the app on this machine. */
export function defaultBinary() {
  // Named the way packaging/build-bin.sh names it: by system and processor.
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const name =
    process.platform === "win32"
      ? "OpenAdmin-win-x64.exe"
      : process.platform === "darwin"
        ? `open-admin-macos-${arch}`
        : `open-admin-linux-${arch}`;
  return path.join(repoRoot, "packaging", "dist", name);
}

// Every process started here, so none outlives the script: not when a step
// throws, not when the app never comes up, not on Ctrl+C.
const children = new Set();
function track(child) {
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}
export function stopAll() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
}
process.on("exit", stopAll);

/**
 * Stop everything this script started when it is interrupted, then exit.
 * `cleanup` runs first, for the caller's own tidying.
 */
export function stopOnInterrupt(cleanup = () => {}) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      try {
        cleanup();
      } finally {
        stopAll();
        process.exit(130);
      }
    });
  }
}

/**
 * `--name value`, `--name=value`, and bare `--name` for the options whose
 * default is `false`. An option that isn't in `defaults` is an error, so a
 * typo stops the run instead of being silently ignored.
 */
export function parseArgs(argv, defaults, usage) {
  const out = { ...defaults };
  const stop = (message) => {
    console.error(`${message}\n\n${usage}`);
    process.exit(2);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    }
    const [name, inline] = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/s) : [];
    if (!name || !(name in defaults)) stop(`Unknown option: ${arg}`);
    if (typeof defaults[name] === "boolean") {
      out[name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) stop(`--${name} needs a value`);
    out[name] = value;
  }
  return out;
}

/** Stop with instructions when there is no packaged app to run. */
export function requireBinary(binary) {
  const resolved = path.resolve(binary);
  if (fs.existsSync(resolved)) return resolved;
  console.error(
    `There is no packaged app at ${resolved}.\n\n` +
      "Build one first:\n" +
      "  npm run package && npm run package:bin     (Windows: npm run package:exe)\n" +
      "or point at one with --binary <path>."
  );
  process.exit(2);
}

const MARKER = ".open-admin-e2e";

/**
 * A folder this run may fill and later delete: a new temporary one, or the
 * one named. A named folder is emptied first, so it is refused unless it is
 * empty, new, or was made by an earlier run of these scripts. Nobody's
 * documents get deleted because of a mistyped path.
 */
export function claimWorkDir(named) {
  if (!named) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-admin-e2e-"));
    fs.writeFileSync(path.join(dir, MARKER), "Made by scripts/e2e. Safe to delete.\n");
    return { dir, temporary: true };
  }
  const dir = path.resolve(named);
  if (
    fs.existsSync(dir) &&
    fs.readdirSync(dir).length > 0 &&
    !fs.existsSync(path.join(dir, MARKER))
  ) {
    console.error(
      `${dir} has things in it that these scripts didn't put there, and the folder is emptied before each run.\n` +
        "Name a folder that is empty or doesn't exist yet."
    );
    process.exit(2);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MARKER), "Made by scripts/e2e. Safe to delete.\n");
  return { dir, temporary: false };
}

/**
 * Start fake-google.mjs on `port` (and its DNS server on `port + 1`).
 * `control(path)` is the plain-HTTP channel the caller uses to change what
 * "Google" answers and to read back what the app asked it.
 */
export async function startStandIn({ dir, port }) {
  const child = track(
    spawn(process.execPath, [path.join(here, "fake-google.mjs"), dir, String(port)], {
      stdio: ["ignore", "pipe", "inherit"],
    })
  );
  let exitCode = null;
  child.on("exit", (code) => (exitCode = code ?? -1));
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => chunk.toString().includes("listening") && resolve());
    child.on("error", (e) => reject(new Error(`The stand-in for Google could not be started: ${e.message}`)));
    child.on("exit", (code) =>
      reject(
        new Error(
          `The stand-in for Google stopped (exit ${code}) before it was ready. ` +
            `It needs the openssl command, and ports ${port} and ${port + 1} free.`
        )
      )
    );
  });
  // A run must not carry on against a stand-in that has died: every answer
  // after that would be a connection error, read as the app's fault.
  const alive = () => exitCode === null;
  return {
    port,
    caFile: path.join(dir, "ca.pem"),
    alive,
    control: async (request) => {
      if (!alive()) throw new Error(`The stand-in for Google has stopped (exit ${exitCode}).`);
      return (await fetch(`http://127.0.0.1:${port}${request}`)).json();
    },
    stop: () => child.kill(),
  };
}

/**
 * A service-account key file of the right shape, with a private key made on
 * the spot. It can sign the token requests the app makes; it is not a
 * credential for anything.
 */
export function writeServiceAccountKey(file, { clientId, clientEmail }) {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: "service_account",
      client_email: clientEmail,
      client_id: clientId,
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    })
  );
}

/**
 * Start the packaged app with its data under `root`, sending everything
 * meant for Google to the stand-in. Resolves once the sign-in page answers.
 */
export async function startApp({ binary, root, port, password, standIn }) {
  const env = { ...process.env };
  // Whatever proxy this machine normally uses must not get between the app
  // and the stand-in.
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY"]) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  env.HTTPS_PROXY = `http://127.0.0.1:${standIn.port}`;
  env.NODE_EXTRA_CA_CERTS = standIn.caFile;
  env.OPEN_ADMIN_DNS_SERVERS = `127.0.0.1:${standIn.port + 1}`;
  env.OPEN_ADMIN_UPDATE_URL = `http://127.0.0.1:${standIn.port}/__release`;

  const child = track(
    spawn(
      binary,
      ["--no-browser", "--port", String(port), "--password", password, "--root", root],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    )
  );
  let output = "";
  let spawnError = null;
  child.on("error", (e) => (spawnError = e));
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const base = `http://localhost:${port}`;
  for (let attempt = 0; ; attempt++) {
    if (spawnError) throw new Error(`The app could not be started: ${spawnError.message}`);
    if (standIn.alive && !standIn.alive()) {
      child.kill();
      throw new Error("The stand-in for Google stopped while the app was starting.");
    }
    try {
      if ((await fetch(`${base}/login`)).status === 200) break;
    } catch {
      // Not listening yet.
    }
    if (child.exitCode !== null || attempt > 240) {
      child.kill();
      throw new Error(`The app did not start on port ${port}. It printed:\n${output}`);
    }
    await sleep(250);
  }
  return {
    base,
    /** Everything the app has printed so far. */
    output: () => output,
    stop: () => child.kill("SIGINT"),
  };
}

/** Sign in with the password, as the browser would, and return ways to call the API. */
export async function signIn(base, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error(`Could not sign in to the app: it answered ${res.status}.`);
  const call = (method, route, body) =>
    fetch(`${base}${route}`, {
      method,
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify(body),
    });
  return { cookie, call, post: (route, body) => call("POST", route, body) };
}

/**
 * Playwright's Chromium. Playwright is deliberately not one of the project's
 * dependencies (nothing that ships needs it), so it is looked up at run time
 * and its absence is explained rather than thrown.
 */
export async function launchBrowser() {
  const require = createRequire(import.meta.url);
  let chromium;
  for (const name of ["playwright", "playwright-core"]) {
    try {
      ({ chromium } = require(name));
      break;
    } catch (e) {
      if (e?.code !== "MODULE_NOT_FOUND") throw e;
    }
  }
  if (!chromium) {
    console.error(
      "This needs Playwright, which is not one of the project's dependencies.\n\n" +
        "  npm install --no-save playwright\n" +
        "  npx playwright install chromium\n\n" +
        "Then run it again. To use a Chromium you already have, set E2E_BROWSER to its path."
    );
    process.exit(2);
  }
  const executablePath = process.env.E2E_BROWSER || undefined;
  return chromium.launch(executablePath ? { executablePath } : {});
}
