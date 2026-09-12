import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { zipSync } from "fflate";
import {
  ensureExtracted,
  isExtracted,
  payloadHash,
  pruneOtherVersions,
} from "../src/extract.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-extract-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const encoder = new TextEncoder();

function samplePayload(marker = "hello"): Uint8Array {
  return zipSync({
    "server.js": encoder.encode(`// ${marker}\n`),
    "package.json": encoder.encode('{"name":"app"}'),
    ".next/server/app/page.js": encoder.encode("page"),
    "public/logo.svg": encoder.encode("<svg/>"),
  });
}

function freshDir(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

describe("payloadHash", () => {
  it("is stable for identical bytes and different otherwise", () => {
    const a = samplePayload("same");
    assert.equal(payloadHash(a), payloadHash(a.slice()));
    assert.notEqual(payloadHash(a), payloadHash(samplePayload("different")));
  });
});

describe("ensureExtracted", () => {
  it("writes every entry, preserving nested paths", () => {
    const appDir = freshDir("first");
    const result = ensureExtracted(samplePayload(), appDir);

    assert.equal(result.extracted, true);
    assert.equal(result.fileCount, 4);
    assert.equal(fs.readFileSync(path.join(appDir, "server.js"), "utf-8"), "// hello\n");
    assert.ok(fs.existsSync(path.join(appDir, ".next", "server", "app", "page.js")));
    assert.ok(fs.existsSync(path.join(appDir, "public", "logo.svg")));
  });

  it("marks the directory complete only after everything lands", () => {
    const appDir = freshDir("marker");
    ensureExtracted(samplePayload(), appDir);
    assert.equal(isExtracted(appDir), true);

    const markerMs = fs.statSync(path.join(appDir, ".complete")).mtimeMs;
    const serverMs = fs.statSync(path.join(appDir, "server.js")).mtimeMs;
    assert.ok(markerMs >= serverMs, "the completion marker must be written last");
  });

  it("skips the work when the same payload is already extracted", () => {
    const appDir = freshDir("idempotent");
    ensureExtracted(samplePayload(), appDir);
    const again = ensureExtracted(samplePayload(), appDir);
    assert.equal(again.extracted, false);
    assert.equal(again.fileCount, 0);
  });

  it("re-extracts over a directory that was never marked complete", () => {
    const appDir = freshDir("partial");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "server.js"), "// truncated");

    const result = ensureExtracted(samplePayload(), appDir);
    assert.equal(result.extracted, true);
    assert.equal(fs.readFileSync(path.join(appDir, "server.js"), "utf-8"), "// hello\n");
  });

  it("refuses an archive entry that would escape the target directory", () => {
    const appDir = freshDir("zipslip");
    const hostile = zipSync({
      "server.js": encoder.encode("// ok\n"),
      "../escape.txt": encoder.encode("outside"),
    });
    assert.throws(
      () => ensureExtracted(hostile, appDir),
      /outside the target directory|unsafe archive entry/
    );
    assert.equal(fs.existsSync(path.join(tmpRoot, "escape.txt")), false);
    assert.equal(fs.existsSync(appDir), false);
  });

  it("leaves nothing behind at the target path when extraction fails", () => {
    const appDir = freshDir("corrupt");
    const notAZip = encoder.encode("this is not a zip archive");
    assert.throws(() => ensureExtracted(notAZip, appDir));
    assert.equal(fs.existsSync(appDir), false);
    const strays = fs.readdirSync(tmpRoot).filter((n) => n.startsWith("corrupt.tmp-"));
    assert.deepEqual(strays, []);
  });
});

describe("pruneOtherVersions", () => {
  it("removes every extracted version except the one in use", () => {
    const appRoot = freshDir("versions");
    const keep = path.join(appRoot, "0.2.0-bbbbbbbbbbbb");
    for (const name of ["0.1.0-aaaaaaaaaaaa", "0.2.0-bbbbbbbbbbbb", "0.1.9-cccccccccccc"]) {
      fs.mkdirSync(path.join(appRoot, name, "nested"), { recursive: true });
      fs.writeFileSync(path.join(appRoot, name, "nested", "file.js"), "x");
    }

    const removed = pruneOtherVersions(appRoot, keep).sort();
    assert.deepEqual(removed, ["0.1.0-aaaaaaaaaaaa", "0.1.9-cccccccccccc"]);
    assert.deepEqual(fs.readdirSync(appRoot), ["0.2.0-bbbbbbbbbbbb"]);
  });

  it("is a no-op when the app folder does not exist yet", () => {
    assert.deepEqual(pruneOtherVersions(path.join(tmpRoot, "never-created"), "irrelevant"), []);
  });
});
