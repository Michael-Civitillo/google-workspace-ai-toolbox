import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  defaultBrowserIsSnap,
  isInHiddenFolder,
  openBrowser,
  openerEnvironment,
  openTarget,
  redirectPage,
  SIGN_IN_PAGE_PREFIX,
  sweepSignInPages,
  writeSignInPage,
} from "../src/browser.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-browser-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let counter = 0;
const freshDir = () => {
  const dir = path.join(tmpRoot, `d${++counter}`);
  fs.mkdirSync(dir);
  return dir;
};

const TICKET_URL = "http://localhost:3000/api/auth/launch?ticket=abc_DEF-123";

/** A stand-in for child_process.spawn that records what it was asked to run. */
function recordingSpawn() {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const spawn = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env });
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, spawn };
}

describe("openerEnvironment", () => {
  it("copies the environment without the launcher's secrets, in any letter case", () => {
    const env = openerEnvironment({
      PATH: "/usr/bin",
      DISPLAY: ":0",
      APP_PASSWORD: "hunter2-hunter2",
      app_session_secret: "s",
      OPEN_ADMIN_INSTANCE_TOKEN: "t",
    });
    assert.deepEqual(env, { PATH: "/usr/bin", DISPLAY: ":0" });
  });
});

describe("sign-in page", () => {
  it("forwards to the URL by script and by refresh, with the URL escaped", () => {
    const page = redirectPage('http://localhost:3000/x?a=1&b="2"<');
    assert.match(page, /http-equiv="refresh" content="0;url=http:\/\/localhost:3000\/x\?a=1&amp;b=&quot;2&quot;&lt;"/);
    assert.match(page, /location\.replace\("http:\/\/localhost:3000\/x\?a=1&b=\\"2\\"\\u003c"\)/);
    assert.ok(!page.includes("<\"") && !page.includes('"<'), "an unescaped < reached the page");
  });

  it("is written readable by its owner only, under a name nobody can predict", () => {
    const dir = freshDir();
    const first = writeSignInPage(dir, TICKET_URL);
    const second = writeSignInPage(dir, TICKET_URL);
    assert.notEqual(first, second);
    assert.ok(path.basename(first).startsWith(SIGN_IN_PAGE_PREFIX));
    assert.match(fs.readFileSync(first, "utf-8"), /ticket=abc_DEF-123/);
    if (process.platform !== "win32") assert.equal(fs.statSync(first).mode & 0o777, 0o600);
  });

  it("is swept away once it is a couple of minutes old, and nothing else is", () => {
    const dir = freshDir();
    const old = writeSignInPage(dir, TICKET_URL);
    const recent = writeSignInPage(dir, TICKET_URL);
    fs.writeFileSync(path.join(dir, "launcher.json"), "{}");
    const then = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(old, then, then);
    fs.utimesSync(path.join(dir, "launcher.json"), then, then);
    sweepSignInPages(dir);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(fs.existsSync(path.join(dir, "launcher.json")), true);
  });
});

describe("openTarget", () => {
  it("opens a page instead of the ticket URL on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as NodeJS.Platform[]) {
      const dir = freshDir();
      const { target, page } = openTarget(TICKET_URL, { platform, pageDir: dir, pageIsReadable: () => true });
      assert.ok(page && target === page && target.startsWith(dir), platform);
      assert.ok(!target.includes("ticket"), "the ticket is on the command line");
    }
  });

  it("passes the URL itself on Windows, without a ticket, or when the browser can't read the folder", () => {
    const dir = freshDir();
    assert.deepEqual(openTarget(TICKET_URL, { platform: "win32", pageDir: dir }), { target: TICKET_URL, page: null });
    assert.deepEqual(openTarget(TICKET_URL, { platform: "linux", pageDir: null }), { target: TICKET_URL, page: null });
    assert.deepEqual(
      openTarget(TICKET_URL, { platform: "linux", pageDir: dir, pageIsReadable: () => false }),
      { target: TICKET_URL, page: null }
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("falls back to the URL when the page can't be written", () => {
    const missing = path.join(tmpRoot, "no-such-folder");
    assert.deepEqual(
      openTarget(TICKET_URL, { platform: "darwin", pageDir: missing }),
      { target: TICKET_URL, page: null }
    );
  });
});

describe("openBrowser", () => {
  it("starts the opener with the given environment and the page, not the ticket", () => {
    const dir = freshDir();
    const { calls, spawn } = recordingSpawn();
    const env = { PATH: "/usr/bin" };
    openBrowser(TICKET_URL, { platform: "darwin", env, pageDir: dir, spawn });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "open");
    assert.equal(calls[0].env, env);
    assert.ok(calls[0].args[0].startsWith(dir));
    assert.ok(!calls[0].args.join(" ").includes("ticket="));
  });

  it("uses start on Windows, with an empty title", () => {
    const { calls, spawn } = recordingSpawn();
    openBrowser("http://localhost:3000", { platform: "win32", env: {}, spawn });
    assert.deepEqual(calls[0].args, ["/c", "start", "", "http://localhost:3000"]);
  });

  it("never passes the launcher's own secrets when no environment is given", () => {
    const { calls, spawn } = recordingSpawn();
    const before = process.env.APP_PASSWORD;
    process.env.APP_PASSWORD = "do-not-leak-this";
    try {
      openBrowser("http://localhost:3000", { platform: "linux", spawn });
    } finally {
      if (before === undefined) delete process.env.APP_PASSWORD;
      else process.env.APP_PASSWORD = before;
    }
    assert.equal(calls[0].command, "xdg-open");
    assert.equal(calls[0].env?.APP_PASSWORD, undefined);
  });
});

describe("Linux browsers in a snap", () => {
  it("knows a folder hidden under the home folder", () => {
    assert.equal(isInHiddenFolder("/home/me/.local/share/App/data", "/home/me"), true);
    assert.equal(isInHiddenFolder("/home/me/OpenAdmin/data", "/home/me"), false);
    assert.equal(isInHiddenFolder("/srv/.hidden/data", "/home/me"), false);
  });

  it("recognises a snap's desktop id", () => {
    const answer = (stdout: string) =>
      (() => ({ stdout })) as unknown as typeof import("node:child_process").spawnSync;
    assert.equal(defaultBrowserIsSnap(answer("firefox_firefox.desktop\n")), true);
    assert.equal(defaultBrowserIsSnap(answer("chromium_chromium.desktop")), true);
    assert.equal(defaultBrowserIsSnap(answer("firefox.desktop")), false);
    assert.equal(defaultBrowserIsSnap(answer("org.mozilla.firefox.desktop")), false);
    assert.equal(defaultBrowserIsSnap(answer("")), false);
  });
});
