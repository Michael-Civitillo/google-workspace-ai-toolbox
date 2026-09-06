#!/usr/bin/env node
/**
 * End-to-end check of a built single-file executable.
 *
 * Starts the binary against a throwaway data folder and exercises the paths
 * that packaging can plausibly break: the auth gate, the CSRF host rule (own
 * host, loopback spellings, and an operator-allow-listed public origin as a
 * reverse proxy would present), the static assets Next expects you to copy
 * yourself, where state is written, the warm restart, and the "already
 * running" shortcut.
 *
 * Usage: node packaging/smoke.mjs [path-to-binary]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
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
    if (child.exitCode !== null) throw new Error(`process exited early (${child.exitCode})`);
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

function start(root, extraArgs = []) {
  const child = spawn(
    binary,
    ["--no-browser", "--port", String(PORT), "--password", PASSWORD, "--root", root, ...extraArgs],
    {
      stdio: ["ignore", "pipe", "pipe"],
      // The launcher passes its environment through to the embedded server;
      // this is how a tunnel or proxy deployment names its public URL.
      env: { ...process.env, APP_ALLOWED_ORIGINS: PUBLIC_ORIGIN },
    }
  );
  let output = "";
  child.stdout.on("data", (b) => (output += b.toString()));
  child.stderr.on("data", (b) => (output += b.toString()));
  return { child, output: () => output };
}

async function stop(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return child.exitCode;
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  // Windows has no signal delivery between processes: kill() terminates the
  // process outright, so exit handlers never run there.
  child.kill(process.platform === "win32" ? undefined : "SIGINT");
  const result = await Promise.race([exited, sleep(timeoutMs).then(() => "timeout")]);
  if (result === "timeout") {
    child.kill("SIGKILL");
    await exited;
    return "timeout";
  }
  return result;
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
    process.exit(1);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-admin-smoke-"));
  console.log(`smoke: ${binary}`);
  console.log(`smoke: data root ${root}\n`);

  const first = start(root);
  let secondHandle = null;
  let thirdHandle = null;

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
    if (thirdHandle) await stop(thirdHandle.child, 5000);
    if (secondHandle) await stop(secondHandle.child, 5000);
    await stop(first.child, 5000);
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\nsmoke: ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`smoke: ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});
