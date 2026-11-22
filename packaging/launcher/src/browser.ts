import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { writeAllSync } from "./fsutil.ts";

/**
 * Opening the app in the user's default browser. Never throws: failing to
 * open a window is a nuisance, not a reason to stop the server the user asked
 * for.
 *
 * Two things are kept from other people on the same machine:
 *
 *  - The one-time sign-in ticket. On macOS and Linux any local user can read
 *    every process's command line (`ps`), and the opener and the browser it
 *    starts would carry the ticket URL there until the browser has used it. So
 *    the URL is written into a small page, readable by this user only, in the
 *    data folder, and that page is opened instead; it forwards the browser to
 *    the URL and is deleted a couple of minutes later. Windows does not show
 *    one user's command lines to another, and there a local .html file may be
 *    set to open in an editor rather than the browser, so the URL is passed as
 *    before. The same can be true on Linux, so there the page is used only
 *    when .html files are known to open in the default browser; otherwise
 *    the URL is passed, as in earlier versions. macOS offers no cheap way to
 *    ask: someone who has pointed .html files at another program gets that
 *    program, and the address printed in the console to open by hand.
 *  - The launcher's secrets. By the time the browser is opened the launcher's
 *    environment holds the password, the session secret and the instance
 *    token for the server. The opener (and so the browser) is started with a
 *    copy of the environment taken before any of that was added, with those
 *    names removed in case they came from outside.
 */

/** Environment names whose values never reach the opener or the browser. */
const SECRET_NAMES = new Set(["APP_PASSWORD", "APP_SESSION_SECRET", "OPEN_ADMIN_INSTANCE_TOKEN"]);

/** A copy of `env` for starting the browser: everything but the secrets. */
export function openerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_NAMES.has(name.toUpperCase())) copy[name] = value;
  }
  return copy;
}

export const SIGN_IN_PAGE_PREFIX = "open-admin-sign-in-";
/** How long a sign-in page is kept. The ticket in it dies after one minute anyway. */
export const SIGN_IN_PAGE_LIFETIME_MS = 2 * 60_000;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A page that forwards the browser to `url`, by script and, failing that, by refresh. */
export function redirectPage(url: string): string {
  const attr = escapeHtml(url);
  const script = JSON.stringify(url).replace(/</g, "\\u003c");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0;url=${attr}">`,
    "<title>Opening Open Admin</title>",
    `<script>location.replace(${script});</script>`,
    `</head><body><p>Opening <a href="${attr}">Open Admin</a> ...</p></body></html>`,
    "",
  ].join("\n");
}

/** Write a sign-in page for `url` into `dir`, readable by this user only. */
export function writeSignInPage(dir: string, url: string): string {
  const file = path.join(dir, `${SIGN_IN_PAGE_PREFIX}${crypto.randomBytes(8).toString("hex")}.html`);
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // The folder is the protection where the file system has no modes.
    }
    writeAllSync(fd, Buffer.from(redirectPage(url), "utf-8"));
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

/** Delete sign-in pages in `dir` older than `maxAgeMs`. */
export function sweepSignInPages(
  dir: string,
  maxAgeMs: number = SIGN_IN_PAGE_LIFETIME_MS,
  now: number = Date.now()
): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SIGN_IN_PAGE_PREFIX) || !name.endsWith(".html")) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs >= maxAgeMs) fs.rmSync(file, { force: true });
    } catch {
      // Gone already.
    }
  }
}

/** True when `dir` lies inside a hidden folder (a name starting with ".") of the home folder. */
export function isInHiddenFolder(dir: string, home: string = os.homedir()): boolean {
  const relative = path.relative(home, dir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return relative.split(path.sep).some((part) => part.startsWith("."));
}

/** What an xdg tool prints, trimmed; "" when it is missing, fails or says nothing. */
function xdgAnswer(run: typeof spawnSync, command: string, args: string[]): string {
  try {
    const result = run(command, args, {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(result.stdout ?? "").trim();
  } catch {
    return "";
  }
}

/** The default browser's desktop id on Linux ("firefox.desktop"), or "". */
function defaultBrowserId(run: typeof spawnSync): string {
  return xdgAnswer(run, "xdg-settings", ["get", "default-web-browser"]);
}

/**
 * True when the default browser is a snap package. Snaps cannot read files in
 * hidden folders of the home folder, which is where the data folder normally
 * is (~/.local/share/...), so a sign-in page there would open as an error.
 * Snap desktop ids have the form "<snap>_<app>.desktop".
 */
export function defaultBrowserIsSnap(run: typeof spawnSync = spawnSync): boolean {
  return /^[a-z0-9][a-z0-9-]*_[A-Za-z0-9._-]+\.desktop$/.test(defaultBrowserId(run));
}

/**
 * True when a local .html file opens in the default browser on this Linux
 * desktop: the program registered for text/html is the default browser.
 * Where it is an editor, or can't be told, a sign-in page would open in the
 * wrong program (or nowhere) while the launcher says the browser is opening.
 */
export function htmlFilesOpenInBrowser(run: typeof spawnSync = spawnSync): boolean {
  const browser = defaultBrowserId(run);
  return browser !== "" && xdgAnswer(run, "xdg-mime", ["query", "default", "text/html"]) === browser;
}

export interface OpenOptions {
  platform?: NodeJS.Platform;
  /** The opener's environment; see openerEnvironment. */
  env?: NodeJS.ProcessEnv;
  /**
   * Where to write a sign-in page when `url` carries a ticket (the data
   * folder), or null to pass the URL itself.
   */
  pageDir?: string | null;
  /** Injectable for tests. */
  spawn?: typeof nodeSpawn;
  pageIsReadable?: (dir: string) => boolean;
}

/** Whether a page written in `dir` would open, in the default browser (Linux). */
function linuxBrowserCanRead(dir: string): boolean {
  return htmlFilesOpenInBrowser() && !(isInHiddenFolder(dir) && defaultBrowserIsSnap());
}

/**
 * What to hand the opener for `url`: a sign-in page when one should and can
 * be written, else the URL itself. Returns the page's path, if one was made.
 */
export function openTarget(url: string, options: OpenOptions = {}): { target: string; page: string | null } {
  const platform = options.platform ?? process.platform;
  const pageDir = options.pageDir ?? null;
  if (!pageDir || platform === "win32") return { target: url, page: null };
  const readable = options.pageIsReadable ?? (platform === "linux" ? linuxBrowserCanRead : () => true);
  if (!readable(pageDir)) return { target: url, page: null };
  try {
    const page = writeSignInPage(pageDir, url);
    return { target: page, page };
  } catch {
    return { target: url, page: null };
  }
}

export function openBrowser(url: string, options: OpenOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? nodeSpawn;
  try {
    const { target, page } = openTarget(url, options);
    if (page) {
      const timer = setTimeout(() => fs.rm(page, { force: true }, () => {}), SIGN_IN_PAGE_LIFETIME_MS);
      timer.unref();
    }
    const spawnOptions = {
      detached: true,
      stdio: "ignore" as const,
      env: options.env ?? openerEnvironment(process.env),
    };
    let child: ChildProcess;
    if (platform === "win32") {
      // The empty string is cmd's window title, which `start` would otherwise
      // take from the URL and then treat the URL as a file path.
      child = spawn("cmd", ["/c", "start", "", target], { ...spawnOptions, windowsHide: true });
    } else if (platform === "darwin") {
      child = spawn("open", [target], spawnOptions);
    } else {
      child = spawn("xdg-open", [target], spawnOptions);
    }
    // A missing opener (a server with no desktop, say) is reported as an
    // 'error' event after spawn returns, which the try/catch here never sees.
    // Unhandled, it lands in the server's uncaught-exception log as a stack
    // trace. The "Ready: <url>" line already tells the user where to go.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Reported by the caller's "Ready: <url>" message instead.
  }
}
