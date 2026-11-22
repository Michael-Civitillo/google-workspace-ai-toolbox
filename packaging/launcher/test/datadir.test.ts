import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { isInsideWindowsFolder, prepareDataDir } from "../src/datadir.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-datadir-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const posix = process.platform !== "win32";
const me = typeof process.getuid === "function" ? process.getuid() : null;
let counter = 0;
const fresh = () => path.join(tmpRoot, `data-${++counter}`);

describe("prepareDataDir on macOS and Linux", { skip: !posix }, () => {
  it("creates the folder for its owner only", () => {
    const dir = fresh();
    const report = prepareDataDir(dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(report, { info: [], warnings: [] });
  });

  it("makes an existing open folder private, and says so", () => {
    const dir = fresh();
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const report = prepareDataDir(dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.match(report.info.join("\n"), /private/);
  });

  it("warns instead when the folder belongs to someone else", () => {
    const dir = fresh();
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const report = prepareDataDir(dir, { uid: (me ?? 0) + 1 });
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755, "changed someone else's folder");
    assert.match(report.warnings.join("\n"), /Other users can open the data folder/);
  });

  it("makes a launcher.env that others can read private", () => {
    const dir = fresh();
    prepareDataDir(dir);
    const envFile = path.join(dir, "launcher.env");
    fs.writeFileSync(envFile, "GEMINI_MODEL=x\n", { mode: 0o644 });
    fs.chmodSync(envFile, 0o644);
    const report = prepareDataDir(dir);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.match(report.info.join("\n"), /launcher\.env private/);
  });

  it("warns about a launcher.env it may not change", () => {
    const dir = fresh();
    prepareDataDir(dir);
    const envFile = path.join(dir, "launcher.env");
    fs.writeFileSync(envFile, "GEMINI_MODEL=x\n", { mode: 0o644 });
    fs.chmodSync(envFile, 0o644);
    const report = prepareDataDir(dir, { uid: (me ?? 0) + 1 });
    assert.match(report.warnings.join("\n"), /launcher\.env can be read by other users/);
  });
});

describe("prepareDataDir on Windows", () => {
  it("knows what is inside the user profile", () => {
    assert.equal(isInsideWindowsFolder("C:\\Users\\me\\AppData\\Local\\X\\data", "C:\\Users\\me"), true);
    assert.equal(isInsideWindowsFolder("c:/users/ME/AppData/Local/X/data", "C:\\Users\\me"), true);
    assert.equal(isInsideWindowsFolder("C:\\Users\\me", "C:\\Users\\me"), true);
    assert.equal(isInsideWindowsFolder("E:\\OpenAdmin\\data", "C:\\Users\\me"), false);
    assert.equal(isInsideWindowsFolder("C:\\Users\\menot\\data", "C:\\Users\\me"), false);
    assert.equal(isInsideWindowsFolder("\\\\server\\share\\data", "C:\\Users\\me"), false);
  });

  it("warns when the data folder is outside the profile", () => {
    const dir = fresh();
    const inside = prepareDataDir(dir, { platform: "win32", env: { USERPROFILE: tmpRoot } });
    assert.deepEqual(inside.warnings, []);
    const outside = prepareDataDir(dir, { platform: "win32", env: { USERPROFILE: path.join(tmpRoot, "someone") } });
    assert.match(outside.warnings.join("\n"), /outside your user profile/);
  });
});
