import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { zipSync } from "fflate";
import { ensureExtracted } from "../src/extract.ts";
import {
  checkAppDir,
  clearFullCheckRequest,
  fullCheckRequested,
  parseManifest,
  requestFullCheck,
  type ManifestEntry,
} from "../src/verify.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-verify-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const encoder = new TextEncoder();
const FILES: Record<string, string> = {
  "server.js": "require('next')\n",
  "package.json": '{"name":"app"}',
  ".next/server/app/page.js": "page",
  "node_modules/next/dist/server/next.js": "module.exports = {}",
};

/** The manifest build-payload.mjs would write for FILES. */
const MANIFEST: ManifestEntry[] = Object.entries(FILES).map(([name, text]) => [
  name,
  Buffer.byteLength(text),
  crypto.createHash("sha256").update(text).digest("hex"),
]);

let counter = 0;
/** A fresh, complete unpacked copy, as the launcher leaves it. */
function unpacked(): string {
  const appDir = path.join(tmpRoot, `0.3.0-${String(++counter).padStart(12, "0")}`);
  const zip = zipSync(Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, encoder.encode(v)])));
  ensureExtracted(zip, appDir);
  return appDir;
}

const at = (appDir: string, relative: string) => path.join(appDir, ...relative.split("/"));

describe("checkAppDir", () => {
  it("passes a copy that matches, in either mode", () => {
    const appDir = unpacked();
    assert.equal(checkAppDir(appDir, MANIFEST, "quick"), null);
    assert.equal(checkAppDir(appDir, MANIFEST, "full"), null);
  });

  it("notices a missing file in either mode", () => {
    const appDir = unpacked();
    fs.rmSync(at(appDir, "node_modules/next/dist/server/next.js"));
    assert.match(checkAppDir(appDir, MANIFEST, "quick") ?? "", /next\.js is missing/);
    assert.match(checkAppDir(appDir, MANIFEST, "full") ?? "", /next\.js is missing/);
  });

  it("notices a file cut short in either mode", () => {
    const appDir = unpacked();
    fs.writeFileSync(at(appDir, "server.js"), "");
    assert.match(checkAppDir(appDir, MANIFEST, "quick") ?? "", /server\.js has the wrong size/);
    assert.match(checkAppDir(appDir, MANIFEST, "full") ?? "", /server\.js has the wrong size/);
  });

  it("in full mode, notices a file changed without changing its size", () => {
    const appDir = unpacked();
    const original = FILES["server.js"];
    fs.writeFileSync(at(appDir, "server.js"), "x".repeat(Buffer.byteLength(original)));
    assert.equal(checkAppDir(appDir, MANIFEST, "quick"), null, "the quick check only counts");
    assert.match(checkAppDir(appDir, MANIFEST, "full") ?? "", /server\.js was changed/);
  });

  it("in full mode, notices a file planted beside the real ones", () => {
    const appDir = unpacked();
    fs.mkdirSync(at(appDir, "node_modules/evil"), { recursive: true });
    fs.writeFileSync(at(appDir, "node_modules/evil/index.js"), "steal()");
    assert.match(checkAppDir(appDir, MANIFEST, "full") ?? "", /node_modules\/evil\/index\.js was added/);
  });

  it("in full mode, refuses a link in place of a file", { skip: process.platform === "win32" }, () => {
    const appDir = unpacked();
    const elsewhere = path.join(tmpRoot, "elsewhere.js");
    fs.writeFileSync(elsewhere, FILES["package.json"]);
    fs.rmSync(at(appDir, "package.json"));
    fs.symlinkSync(elsewhere, at(appDir, "package.json"));
    assert.match(checkAppDir(appDir, MANIFEST, "full") ?? "", /package\.json is a link/);
    assert.match(checkAppDir(appDir, MANIFEST, "quick") ?? "", /package\.json is not a regular file/);
  });

  it("allows the launcher's own marker files", () => {
    const appDir = unpacked();
    requestFullCheck(appDir);
    assert.equal(fullCheckRequested(appDir), true);
    assert.equal(checkAppDir(appDir, MANIFEST, "full"), null);
    clearFullCheckRequest(appDir);
    assert.equal(fullCheckRequested(appDir), false);
  });

  it("only allows them at the top of the folder", () => {
    const appDir = unpacked();
    fs.writeFileSync(at(appDir, ".next/.complete"), "");
    assert.match(checkAppDir(appDir, MANIFEST, "full") ?? "", /\.next\/\.complete was added/);
  });
});

describe("parseManifest", () => {
  it("reads what build-payload.mjs writes", () => {
    assert.deepEqual(parseManifest(JSON.stringify(MANIFEST)), MANIFEST);
  });

  it("refuses anything malformed", () => {
    for (const bad of ["{}", "[1]", '[["a", "1", "' + "0".repeat(64) + '"]]', '[["a", 1, "abc"]]', "nope"]) {
      assert.throws(() => parseManifest(bad), Error, bad);
    }
  });
});
