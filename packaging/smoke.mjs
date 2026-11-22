#!/usr/bin/env node
/**
 * End-to-end check of a built single-file executable.
 *
 * Starts the binary against a throwaway data folder and exercises the paths
 * that packaging can plausibly break: the auth gate, the CSRF host rule (own
 * host, loopback spellings, and an operator-allow-listed public origin as a
 * reverse proxy would present), the static assets Next expects you to copy
 * yourself, where state is written, what happens when the port is taken, the
 * warm restart, and the "already running" shortcut. Then the launcher's own
 * guarantees: two launches at once on a fresh install, the check of the
 * unpacked copy and what clean-up may delete, a stale lock pointing at
 * another program, a server bound to every address, and what launcher.env
 * may not set.
 *
 * Usage: node packaging/smoke.mjs [path-to-binary]
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packagingDir = path.dirname(fileURLToPath(import.meta.url));

/** Mirrors the naming in build-bin.sh / build-exe.ps1. */
function defaultBinaryName() {
  if (process.platform === "win32") return "OpenAdmin-win-x64.exe";
  const platform = process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `open-admin-${platform}-${arch}`;
}

const binary = path.resolve(process.argv[2] ?? path.join(packagingDir, "dist", defaultBinaryName()));
const PORT = Number(process.env.SMOKE_PORT ?? 3123);
const PASSWORD = "smoke-test-password-123";
const BASE = `http://localhost:${PORT}`;
/** What a browser would send when reaching the app through a reverse proxy. */
const PUBLIC_ORIGIN = "https://admin.example.test";

let failures = 0;
let checks = 0;

/**
 * A run that stops before its last line has not passed. Node ends a script
 * with exit code 0 once nothing is left that could wake it, even half-way
 * through an `await`: a step waiting for something that will never happen
 * would end the run early, silently, and as a success. So the run counts as
 * failed until finish() says otherwise.
 */
let finished = false;
process.exitCode = 1;
process.on("exit", () => {
  if (!finished) console.error("\nsmoke: the run stopped before it finished. That counts as a failure.");
});

function finish(code) {
  finished = true;
  process.exit(code);
}

function check(name, condition, detail = "") {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function skip(name, why) {
  console.log(`  skip ${name} - ${why}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The promise's value, or "timeout"; no timer is left running either way. */
function orTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Whether a child process has ended. One ended by a signal has no exit code,
 * only the signal's name, and that is every child this script stops on
 * Windows, where kill() ends the process outright.
 */
const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

async function get(pathname, init = {}) {
  return fetch(`${BASE}${pathname}`, { redirect: "manual", ...init });
}

async function postJson(pathname, body, headers = {}) {
  return fetch(`${BASE}${pathname}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function waitForReady(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited(child)) {
      throw new Error(`process exited early (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const res = await get("/login");
      if (res.status === 200) return Date.now();
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`server was not ready within ${timeoutMs} ms`);
}

/** Every launcher started, so that none outlives the run. */
const started = [];

/** Start the binary with exactly these arguments and extra environment. */
function launchWith(args, env = {}) {
  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    // The launcher passes its environment through to the embedded server;
    // this is how a tunnel or proxy deployment names its public URL.
    env: { ...process.env, APP_ALLOWED_ORIGINS: PUBLIC_ORIGIN, ...env },
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b.toString()));
  child.stderr.on("data", (b) => (output += b.toString()));
  const handle = { child, output: () => output };
  started.push(handle);
  return handle;
}

function launch(args) {
  return launchWith(["--no-browser", ...args]);
}

/** Resolves with the exit code, or "timeout". */
function exitOf(handle, timeoutMs) {
  const { child } = handle;
  if (hasExited(child)) return Promise.resolve(child.exitCode);
  return orTimeout(new Promise((resolve) => child.once("exit", (code) => resolve(code))), timeoutMs);
}

const lastLine = (handle) => handle.output().trim().split("\n").pop();

async function statusOf(url) {
  try {
    return (await fetch(url, { redirect: "manual" })).status;
  } catch {
    return null;
  }
}

/** Unpacked application folders: <version>-<12 hex>. */
const VERSION_DIR = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[0-9a-f]{12}$/;

/**
 * macOS and Linux: a stand-in for the desktop's browser opener (`open`,
 * `xdg-open`) that records what it was given instead of opening anything,
 * and a default browser that is not a snap. Put first on PATH.
 */
function browserStub(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const record = path.join(dir, "opened.txt");
  const opener =
    "#!/bin/sh\n" +
    `printf '%s\\n' "$1" >> "${record}"\n` +
    `if [ -n "\${APP_PASSWORD+x}" ]; then echo "APP_PASSWORD present" >> "${record}"; fi\n`;
  for (const name of ["open", "xdg-open"]) {
    fs.writeFileSync(path.join(dir, name), opener);
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  // A desktop where the default browser also opens .html files; only there
  // does the launcher hand over a page instead of the URL.
  for (const name of ["xdg-settings", "xdg-mime"]) {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\necho firefox.desktop\n");
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return {
    env: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
    opened: () =>
      fs.existsSync(record) ? fs.readFileSync(record, "utf-8").split("\n").filter(Boolean) : [],
  };
}

function start(root, extraArgs = []) {
  return launch(["--port", String(PORT), "--password", PASSWORD, "--root", root, ...extraArgs]);
}

/** Wait for a launcher to announce the address it ended up on. */
async function waitForReadyUrl(handle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = handle.output().match(/Ready: (http:\/\/localhost:\d+)/)?.[1];
    if (url) return url;
    if (hasExited(handle.child)) return null;
    await sleep(250);
  }
  return null;
}

/**
 * Stop a launcher and give its exit code (null when a signal ended it), or
 * "timeout" when it had to be killed. Safe to call again for one already
 * stopped, which the clean-up at the end does for every launcher started.
 */
async function stop(child, timeoutMs = 10_000) {
  if (hasExited(child)) return child.exitCode;
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  // Windows has no signal delivery between processes: kill() terminates the
  // process outright, so exit handlers never run there.
  child.kill(process.platform === "win32" ? undefined : "SIGINT");
  const result = await orTimeout(exited, timeoutMs);
  if (result !== "timeout") return result;
  child.kill("SIGKILL");
  // Bounded too: a process that can't be killed must not hold the run.
  await orTimeout(exited, 5000);
  return "timeout";
}

/**
 * Delete the run's folder. Not a check: on Windows a file a process has just
 * let go of can stay locked for a moment (a virus scanner reading it), and a
 * folder left in the temporary directory says nothing about the build.
 */
function removeDataRoot(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.log(`\nsmoke: could not remove ${root} (${e instanceof Error ? e.message : e})`);
  }
}

function findFiles(dir, name, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findFiles(full, name, found);
    else if (entry.name === name) found.push(full);
  }
  return found;
}

async function main() {
  if (!fs.existsSync(binary)) {
    console.error(`smoke: no binary at ${binary}`);
    finish(1);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-admin-smoke-"));
  console.log(`smoke: ${binary}`);
  console.log(`smoke: data root ${root}\n`);

  const first = start(root);
  let secondHandle = null;
  let thirdHandle = null;
  let fallbackHandle = null;

  try {
    const coldStart = Date.now();
    await waitForReady(first.child, 120_000);
    console.log(`smoke: ready in ${((Date.now() - coldStart) / 1000).toFixed(1)}s\n`);

    console.log("Unauthenticated surface");
    check("GET /login serves the sign-in page", (await get("/login")).status === 200);
    const rootRes = await get("/");
    check(
      "GET / redirects to /login",
      rootRes.status === 307 && (rootRes.headers.get("location") ?? "").includes("/login"),
      `status ${rootRes.status}`
    );
    check("GET /api/tenants is refused", (await get("/api/tenants")).status === 401);

    console.log("\nCSRF host rule");
    const crossOrigin = await postJson(
      "/api/auth/login",
      { password: PASSWORD },
      { origin: "http://evil.example" }
    );
    check("cross-origin login is blocked", crossOrigin.status === 403);

    const numericOrigin = await postJson(
      "/api/auth/login",
      { password: PASSWORD },
      { origin: `http://127.0.0.1:${PORT}` }
    );
    check(
      "login works from the 127.0.0.1 spelling",
      numericOrigin.status === 200,
      `status ${numericOrigin.status}`
    );

    const publicOrigin = await postJson(
      "/api/auth/login",
      { password: PASSWORD },
      { origin: PUBLIC_ORIGIN }
    );
    check(
      "login works from an allow-listed public origin (reverse proxy)",
      publicOrigin.status === 200,
      `status ${publicOrigin.status}`
    );

    const nearMiss = await postJson(
      "/api/auth/login",
      { password: PASSWORD },
      { origin: `${PUBLIC_ORIGIN}:8443` }
    );
    check("a public origin on another port is still blocked", nearMiss.status === 403);

    const login = await postJson(
      "/api/auth/login",
      { password: PASSWORD },
      { origin: BASE }
    );
    check("login works from the localhost spelling", login.status === 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    check("login sets a session cookie", cookie.startsWith("gws_toolbox_session="));

    console.log("\nSigning in with a one-time ticket (what the launcher does)");
    const ticketRes = await postJson(
      "/api/auth/launch-ticket",
      { password: PASSWORD },
      { origin: BASE }
    );
    check("the saved password buys a ticket", ticketRes.status === 200, `status ${ticketRes.status}`);
    const ticket = ticketRes.status === 200 ? (await ticketRes.json()).ticket : "";
    const redeemPath = `/api/auth/launch?ticket=${encodeURIComponent(ticket)}`;
    const redeemed = await get(redeemPath);
    const ticketCookie = (redeemed.headers.get("set-cookie") ?? "").split(";")[0];
    check(
      "the ticket is redeemed for a session",
      redeemed.status === 200 && ticketCookie.startsWith("gws_toolbox_session="),
      `status ${redeemed.status}`
    );
    check(
      "that session is accepted",
      (await get("/api/tenants", { headers: { cookie: ticketCookie } })).status === 200
    );
    const reused = await get(redeemPath);
    check(
      "a ticket cannot be used twice",
      reused.status === 302 &&
        reused.headers.get("location") === "/login" &&
        !reused.headers.get("set-cookie"),
      `status ${reused.status}`
    );
    check(
      "a made-up ticket is sent to the sign-in page",
      (await get("/api/auth/launch?ticket=not-a-real-ticket")).status === 302
    );
    check(
      "a ticket request from another site is blocked",
      (
        await postJson(
          "/api/auth/launch-ticket",
          { password: PASSWORD },
          { origin: "http://evil.example" }
        )
      ).status === 403
    );
    check(
      "a wrong password buys nothing",
      (
        await postJson(
          "/api/auth/launch-ticket",
          { password: "not-the-password-123" },
          { origin: BASE }
        )
      ).status === 401
    );

    console.log("\nAuthenticated surface");
    const authed = { cookie };
    check("GET / renders the dashboard", (await get("/", { headers: authed })).status === 200);
    check(
      "GET /api/tenants is allowed",
      (await get("/api/tenants", { headers: authed })).status === 200
    );

    const statusRes = await get("/api/gws/status", { headers: authed });
    const status = await statusRes.json();
    check("status route reports the packaged build", status.packaged === true);
    check("status route marks the CLI optional", status.required === false);

    console.log("\nAssets Next expects you to copy");
    check("GET /logo.svg serves from public/", (await get("/logo.svg")).status === 200);
    const loginHtml = await (await get("/login")).text();
    const cssHref = loginHtml.match(/\/_next\/static\/[^"']+\.css/)?.[0];
    check("the sign-in page references a stylesheet", Boolean(cssHref));
    if (cssHref) {
      check("GET the stylesheet serves from .next/static", (await get(cssHref)).status === 200);
    }

    console.log("\nState lands in the data folder, not the app folder");
    const created = await postJson(
      "/api/tenants",
      {
        name: "Smoke Test",
        adminEmail: "admin@example.com",
        credentialsFile:
          process.platform === "win32" ? "C:\\smoke\\sa.json" : "/smoke/sa.json",
        color: "blue",
      },
      { origin: BASE, cookie }
    );
    check("a tenant can be created", created.status === 201, `status ${created.status}`);
    check(
      "tenants.json is in the data folder",
      fs.existsSync(path.join(root, "data", "tenants.json"))
    );
    const strays = findFiles(path.join(root, "app"), "tenants.json");
    check(
      "no state was written into the disposable app folder",
      strays.length === 0,
      strays.join(", ")
    );
    check(
      "the lock file records the running instance",
      fs.existsSync(path.join(root, "data", "launcher.lock"))
    );
    let lockRecord = {};
    try {
      lockRecord = JSON.parse(fs.readFileSync(path.join(root, "data", "launcher.lock"), "utf-8"));
    } catch {
      // Reported by the next check.
    }
    check(
      "the lock file carries the instance token",
      /^[0-9a-f]{64}$/.test(lockRecord.token ?? "")
    );
    if (process.platform === "win32") {
      skip("the lock file is private to its owner", "Windows protects it with the profile's permissions");
    } else {
      check(
        "the lock file is private to its owner",
        (fs.statSync(path.join(root, "data", "launcher.lock")).mode & 0o777) === 0o600
      );
    }

    // The first instance is still holding PORT, which makes it the "other
    // program" for two launches that keep their state somewhere else.
    console.log("\nA port that is already taken");
    const refused = launch([
      "--port", String(PORT),
      "--password", PASSWORD,
      "--root", root,
      "--data-dir", path.join(root, "data-refused"),
    ]);
    const refusedExit = await new Promise((resolve) => refused.child.once("exit", resolve));
    check(
      "a busy port asked for with --port is refused",
      refusedExit === 3 && /already in use/i.test(refused.output()),
      `exit ${refusedExit}`
    );

    // What a double-click looks like: no --port, and the remembered port busy.
    // Same --root so the unpacked application is reused; its own data folder,
    // seeded the way a previous run would have left it.
    const fallbackData = path.join(root, "data-fallback");
    fs.mkdirSync(fallbackData, { recursive: true });
    fs.writeFileSync(
      path.join(fallbackData, "launcher.json"),
      JSON.stringify({
        version: 1,
        port: PORT,
        password: PASSWORD,
        sessionSecret: "smoke".repeat(13),
        openBrowser: false,
      })
    );
    fallbackHandle = launch(["--root", root, "--data-dir", fallbackData]);
    const fallbackUrl = await waitForReadyUrl(fallbackHandle, 60_000);
    check(
      "without --port, a busy port moves to the next free one",
      fallbackUrl !== null && fallbackUrl !== BASE,
      fallbackHandle.output().trim().split("\n").pop()
    );
    if (fallbackUrl) {
      check(
        "the launcher says which port it moved to",
        /in use by another program, so this run uses port \d+/.test(fallbackHandle.output())
      );
      const moved = await fetch(`${fallbackUrl}/login`, { redirect: "manual" });
      check("the app answers on the port it moved to", moved.status === 200);
      const movedLogin = await fetch(`${fallbackUrl}/api/auth/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", origin: fallbackUrl },
        body: JSON.stringify({ password: PASSWORD }),
      });
      check("sign-in works on the port it moved to", movedLogin.status === 200);
      const saved = JSON.parse(
        fs.readFileSync(path.join(fallbackData, "launcher.json"), "utf-8")
      );
      check("the move is for this run only, not remembered", saved.port === PORT);
    }
    await stop(fallbackHandle.child, 5000);
    fallbackHandle = null;

    // A first run the way a double-click starts it: no password given. It must
    // come up without asking for one, and must not print the one it generates.
    console.log("\nA first run with no password given");
    const freshData = path.join(root, "data-first-run");
    const firstRun = launch(["--root", root, "--data-dir", freshData]);
    const firstRunUrl = await waitForReadyUrl(firstRun, 60_000);
    check("starts without being given, or asking for, a password", firstRunUrl !== null);
    let generated = "";
    try {
      generated = JSON.parse(
        fs.readFileSync(path.join(freshData, "launcher.json"), "utf-8")
      ).password;
    } catch {
      // Reported by the next check.
    }
    check("generates and saves a sign-in password", typeof generated === "string" && generated.length >= 20);
    check(
      "does not print the generated password",
      generated.length > 0 && !firstRun.output().includes(generated)
    );
    if (firstRunUrl) {
      const withGenerated = await fetch(`${firstRunUrl}/api/auth/launch-ticket`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", origin: firstRunUrl },
        body: JSON.stringify({ password: generated }),
      });
      check("the generated password is the one the server accepts", withGenerated.status === 200);
    }
    await stop(firstRun.child, 5000);

    // A double-click, then another a moment later, on a machine that has never
    // run it: the second used to delete the folder the first was starting from.
    console.log("\nTwo launches a moment apart on a fresh install");
    const fresh = path.join(root, "fresh");
    const freshPort = PORT + 50;
    const freshArgs = ["--root", fresh, "--port", String(freshPort), "--password", PASSWORD];
    const one = launch(freshArgs);
    await sleep(200);
    const two = launch(freshArgs);
    const oneUrl = await waitForReadyUrl(one, 120_000);
    const twoExit = await exitOf(two, 120_000);
    check("the first comes up", oneUrl !== null, lastLine(one));
    check(
      "the second waits for it, then hands over to it",
      twoExit === 0 && /already running/i.test(two.output()),
      `exit ${twoExit}: ${lastLine(two)}`
    );
    check(
      "the first is still serving afterwards",
      !hasExited(one.child) && (await statusOf(`http://127.0.0.1:${freshPort}/login`)) === 200
    );
    const freshEntries = fs.existsSync(path.join(fresh, "app")) ? fs.readdirSync(path.join(fresh, "app")) : [];
    check(
      "one unpacked copy, nothing left half-done",
      freshEntries.length === 1 && VERSION_DIR.test(freshEntries[0]),
      freshEntries.join(", ")
    );
    await stop(one.child, 5000);

    // Every start checks the unpacked copy against the program (all files, by
    // hash, outside the per-user folder - as here, with --root) and replaces
    // one that does not match. Clean-up deletes only the launcher's own folders.
    console.log("\nThe unpacked copy is checked before each start");
    const freshApp = path.join(fresh, "app");
    const appDir = path.join(freshApp, freshEntries[0] ?? "missing");
    const serverJs = path.join(appDir, "server.js");
    const genuine = fs.existsSync(serverJs) ? fs.readFileSync(serverJs) : Buffer.alloc(0);
    if (fs.existsSync(serverJs)) fs.appendFileSync(serverJs, "\n// changed by the smoke test\n");
    if (fs.existsSync(appDir)) fs.writeFileSync(path.join(appDir, "planted.js"), "// planted by the smoke test\n");
    fs.mkdirSync(path.join(freshApp, "My Files"), { recursive: true });
    fs.writeFileSync(path.join(freshApp, "My Files", "keep.txt"), "not the launcher's");
    const olderCopy = path.join(freshApp, "0.0.1-aaaaaaaaaaaa");
    fs.mkdirSync(olderCopy, { recursive: true });
    fs.writeFileSync(path.join(olderCopy, ".complete"), "");
    const checked = launch(freshArgs);
    const checkedUrl = await waitForReadyUrl(checked, 120_000);
    check(
      "a changed copy is noticed and unpacked again",
      checkedUrl !== null && /damaged or has been changed/.test(checked.output()),
      lastLine(checked)
    );
    check(
      "what was changed or planted is gone",
      !fs.existsSync(path.join(appDir, "planted.js")) &&
        fs.existsSync(serverJs) &&
        fs.readFileSync(serverJs).equals(genuine)
    );
    for (let i = 0; i < 20 && fs.existsSync(olderCopy); i++) await sleep(250);
    check("an older version of the launcher's own is cleaned up", !fs.existsSync(olderCopy));
    check(
      "a folder that is not the launcher's is left alone",
      fs.existsSync(path.join(freshApp, "My Files", "keep.txt"))
    );
    await stop(checked.child, 5000);
    const reset = launch([...freshArgs, "--reset-app-cache"]);
    const resetUrl = await waitForReadyUrl(reset, 120_000);
    check(
      "--reset-app-cache unpacks again and leaves other folders alone",
      resetUrl !== null &&
        /Unpacked/.test(reset.output()) &&
        fs.existsSync(path.join(freshApp, "My Files", "keep.txt")),
      lastLine(reset)
    );
    await stop(reset.child, 5000);

    // What closing the window leaves behind, a reused process id, and another
    // program on the port: the launcher used to take that program for itself
    // and send it the saved password.
    console.log("\nA stale lock pointing at another program");
    const foreignPort = PORT + 60;
    const seen = [];
    const foreign = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body });
        res.writeHead(req.url === "/login" ? 200 : 404, { "content-type": "text/html" });
        res.end("<html>another program</html>");
      });
    });
    await new Promise((resolve) => foreign.listen(foreignPort, "127.0.0.1", resolve));
    try {
      const staleData = path.join(root, "data-stale");
      fs.mkdirSync(staleData, { recursive: true });
      fs.writeFileSync(
        path.join(staleData, "launcher.json"),
        JSON.stringify({
          version: 1,
          port: foreignPort,
          password: PASSWORD,
          sessionSecret: "stale".repeat(13),
          openBrowser: true,
        })
      );
      fs.writeFileSync(
        path.join(staleData, "launcher.lock"),
        JSON.stringify({
          pid: process.pid,
          port: foreignPort,
          host: "127.0.0.1",
          startedAt: new Date().toISOString(),
          token: crypto.randomBytes(32).toString("hex"),
        })
      );
      // Windows has no stand-in for the opener, so there the browser stays shut.
      const posix = process.platform !== "win32";
      const stub = posix ? browserStub(path.join(root, "browser-stub")) : null;
      const stale = launchWith(
        ["--root", root, "--data-dir", staleData, ...(posix ? [] : ["--no-browser"])],
        stub?.env ?? {}
      );
      const staleUrl = await waitForReadyUrl(stale, 60_000);
      check(
        "does not take the other program for itself",
        staleUrl !== null &&
          staleUrl !== `http://localhost:${foreignPort}` &&
          !/already running/i.test(stale.output()),
        lastLine(stale)
      );
      check(
        "sends the other program nothing but probes",
        seen.length > 0 && seen.every((r) => r.method === "GET" && !r.body.includes(PASSWORD)),
        seen.map((r) => `${r.method} ${r.url}`).join(", ")
      );
      if (stub && staleUrl) {
        for (let i = 0; i < 20 && stub.opened().length === 0; i++) await sleep(250);
        const [page = "", ...rest] = stub.opened();
        const pageText = fs.existsSync(page) ? fs.readFileSync(page, "utf-8") : "";
        check(
          "the ticket reaches the browser in a private page, not on a command line",
          !page.includes("ticket=") &&
            pageText.includes(`${staleUrl}/api/auth/launch?ticket=`) &&
            (fs.statSync(page).mode & 0o777) === 0o600,
          page
        );
        check("the browser does not inherit the password", !rest.includes("APP_PASSWORD present"));
      } else {
        skip("the ticket reaches the browser in a private page", "Windows passes the URL; see browser.ts");
        skip("the browser does not inherit the password", "no stand-in for the Windows opener");
      }
      await stop(stale.child, 5000);
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
    }

    // Someone downloads this version while 0.2.0 is still open. Its lock has
    // no token, so it can't prove itself; starting a second server beside it
    // would put two on one data folder.
    console.log("\nAn older version still running");
    const olderPort = PORT + 65;
    const olderSeen = [];
    const older = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        olderSeen.push({ method: req.method, url: req.url, body });
        res.writeHead(req.url === "/login" ? 200 : 404, { "content-type": "text/html" });
        res.end("<html><head><title>Google Workspace Open Admin</title></head><body>Enter the Open Admin password to continue.</body></html>");
      });
    });
    await new Promise((resolve) => older.listen(olderPort, "127.0.0.1", resolve));
    try {
      const olderData = path.join(root, "data-older");
      fs.mkdirSync(olderData, { recursive: true });
      fs.writeFileSync(
        path.join(olderData, "launcher.json"),
        JSON.stringify({ version: 1, port: olderPort, password: PASSWORD, sessionSecret: "older".repeat(13), openBrowser: true })
      );
      // What 0.2.0 wrote: no token.
      fs.writeFileSync(
        path.join(olderData, "launcher.lock"),
        JSON.stringify({ pid: process.pid, port: olderPort, host: "127.0.0.1", startedAt: new Date().toISOString() })
      );
      const second = launch(["--root", root, "--data-dir", olderData]);
      const code = await exitOf(second, 60_000);
      check(
        "says an older version is running and stops, instead of starting beside it",
        code === 7 && /older version of .* is still running/i.test(second.output()) && /Close its window/.test(second.output()),
        `exit ${code}: ${lastLine(second)}`
      );
      check(
        "sends the older copy nothing but reads",
        olderSeen.length > 0 && olderSeen.every((r) => r.method === "GET" && !r.body.includes(PASSWORD)),
        olderSeen.map((r) => `${r.method} ${r.url}`).join(", ")
      );
      check(
        "leaves the older copy's lock file alone",
        JSON.parse(fs.readFileSync(path.join(olderData, "launcher.lock"), "utf-8")).port === olderPort
      );
    } finally {
      await new Promise((resolve) => older.close(resolve));
    }

    // Windows refuses connections to 0.0.0.0, so a launcher that waited for
    // the server at its bind address gave up after a minute and stopped it.
    console.log("\nBound to every address");
    const anyPort = PORT + 70;
    const anyData = path.join(root, "data-anyhost");
    fs.mkdirSync(anyData, { recursive: true });
    fs.writeFileSync(
      path.join(anyData, "launcher.env"),
      "NODE_TLS_REJECT_UNAUTHORIZED=0\nNODE_OPTIONS=--require ./not-a-real-file.js\nGEMINI_MODEL=smoke\n"
    );
    const anyHost = launch([
      "--root", root,
      "--data-dir", anyData,
      "--host", "0.0.0.0",
      "--port", String(anyPort),
      "--password", PASSWORD,
    ]);
    const anyUrl = await waitForReadyUrl(anyHost, 60_000);
    check("starts, and is opened as localhost", anyUrl === `http://localhost:${anyPort}`, lastLine(anyHost));
    check(
      "answers on loopback",
      (await statusOf(`http://127.0.0.1:${anyPort}/login`)) === 200
    );
    check(
      "launcher.env may not turn off certificate checks or load code",
      /Ignored in launcher\.env: NODE_TLS_REJECT_UNAUTHORIZED, NODE_OPTIONS\b/.test(anyHost.output()) &&
        /Loaded from launcher\.env: GEMINI_MODEL/.test(anyHost.output())
    );
    await stop(anyHost.child, 5000);

    console.log("\nSecond instance");
    thirdHandle = start(root);
    const secondExit = await new Promise((resolve) => thirdHandle.child.once("exit", resolve));
    check("a second launch exits cleanly", secondExit === 0, `exit ${secondExit}`);
    check(
      "a second launch reports the running instance",
      /already running/i.test(thirdHandle.output()),
      thirdHandle.output().trim().split("\n").pop()
    );
    thirdHandle = null;

    console.log("\nShutdown and warm restart");
    const exitCode = await stop(first.child);
    check("stops when asked", exitCode !== "timeout", "did not exit within 10s");
    if (process.platform === "win32") {
      skip(
        "the lock file is cleaned up",
        "no graceful signal on Windows; a stale lock is detected and replaced on the next start"
      );
    } else {
      check(
        "the lock file is cleaned up",
        !fs.existsSync(path.join(root, "data", "launcher.lock"))
      );
    }

    secondHandle = start(root);
    const warmStart = Date.now();
    await waitForReady(secondHandle.child, 60_000);
    const warmMs = Date.now() - warmStart;
    check("restarts without re-extracting", !/Unpacked/i.test(secondHandle.output()));
    check(`warm start is quick (${(warmMs / 1000).toFixed(1)}s)`, warmMs < 30_000);
    const reLogin = await postJson(
      "/api/auth/login",
      { password: PASSWORD },
      { origin: BASE }
    );
    check("the saved password still works", reLogin.status === 200);
  } finally {
    if (fallbackHandle) await stop(fallbackHandle.child, 5000);
    if (thirdHandle) await stop(thirdHandle.child, 5000);
    if (secondHandle) await stop(secondHandle.child, 5000);
    await stop(first.child, 5000);
    for (const handle of started) await stop(handle.child, 5000);
    removeDataRoot(root);
  }

  console.log(`\nsmoke: ${checks - failures}/${checks} checks passed`);
  finish(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`smoke: ${e instanceof Error ? e.stack : e}`);
  finish(1);
});
