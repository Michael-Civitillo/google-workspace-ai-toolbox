import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { zipSync } from "fflate";
import {
  classifyName,
  discardDir,
  ensureExtracted,
  isExtracted,
  payloadHash,
  pruneOtherVersions,
  resetAppCache,
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

  it("keeps a complete copy that is already in place rather than replacing it", () => {
    const appDir = freshDir("already-complete");
    ensureExtracted(samplePayload("first"), appDir);
    const again = ensureExtracted(samplePayload("second"), appDir);
    assert.equal(again.extracted, false);
    assert.equal(fs.readFileSync(path.join(appDir, "server.js"), "utf-8"), "// first\n");
  });

  it("removes a leftover temporary folder of a process with its own id", () => {
    const appDir = freshDir("own-leftover");
    const leftover = `${appDir}.tmp-${process.pid}`;
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, "stale.js"), "old");
    ensureExtracted(samplePayload(), appDir);
    assert.equal(fs.existsSync(leftover), false);
    assert.equal(fs.existsSync(path.join(appDir, "stale.js")), false);
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

/** An unpacked version as the launcher leaves it: some files and the marker. */
function unpackedVersion(appRoot: string, name: string, marked = true): string {
  const dir = path.join(appRoot, name);
  fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
  fs.writeFileSync(path.join(dir, "nested", "file.js"), "x");
  if (marked) fs.writeFileSync(path.join(dir, ".complete"), "2026-01-01T00:00:00.000Z\n");
  return dir;
}

const DEAD = 999_999_999;
const nobodyAlive = { isAlive: () => false };

describe("classifyName", () => {
  it("recognises only the names this launcher creates", () => {
    assert.deepEqual(classifyName("0.3.0-0123456789ab"), { kind: "version" });
    assert.deepEqual(classifyName("1.0.0-rc.1-0123456789ab"), { kind: "version" });
    assert.deepEqual(classifyName("0.3.0-0123456789ab.tmp-4242"), { kind: "tmp", pid: 4242 });
    assert.deepEqual(classifyName("0.3.0-0123456789ab.del-4242-a1b2c3"), { kind: "del" });
    for (const name of [
      "app",
      "my-notes",
      "0.3.0",
      "0.3.0-0123456789AB",
      "0.3.0-0123456789a",
      "v0.3.0-0123456789ab",
      "0.3.0-0123456789ab.tmp-",
      "0.3.0-0123456789ab.tmp-12x",
      "0.3.0-0123456789ab.old",
      "notes.tmp-12",
    ]) {
      assert.equal(classifyName(name), null, name);
    }
  });
});

describe("pruneOtherVersions", () => {
  it("removes every extracted version except the one in use", () => {
    const appRoot = freshDir("versions");
    const keep = path.join(appRoot, "0.2.0-bbbbbbbbbbbb");
    for (const name of ["0.1.0-aaaaaaaaaaaa", "0.2.0-bbbbbbbbbbbb", "0.1.9-cccccccccccc"]) {
      unpackedVersion(appRoot, name);
    }

    const removed = pruneOtherVersions(appRoot, keep).sort();
    assert.deepEqual(removed, ["0.1.0-aaaaaaaaaaaa", "0.1.9-cccccccccccc"]);
    assert.deepEqual(fs.readdirSync(appRoot), ["0.2.0-bbbbbbbbbbbb"]);
  });

  it("leaves everything that is not one of its own folders alone", () => {
    // Portable mode puts the app folder beside the executable, where an "app"
    // folder of the person's own may already be.
    const appRoot = freshDir("someone-elses-app-folder");
    const keep = unpackedVersion(appRoot, "0.3.0-dddddddddddd");
    fs.mkdirSync(path.join(appRoot, "My Project", "src"), { recursive: true });
    fs.writeFileSync(path.join(appRoot, "My Project", "src", "index.js"), "mine");
    fs.mkdirSync(path.join(appRoot, "0.2.0-not-a-hash"));
    fs.writeFileSync(path.join(appRoot, "notes.txt"), "mine too");
    // Our name, but no marker: not provably ours, so not removed.
    unpackedVersion(appRoot, "0.1.0-eeeeeeeeeeee", false);

    assert.deepEqual(pruneOtherVersions(appRoot, keep, nobodyAlive), []);
    assert.deepEqual(fs.readdirSync(appRoot).sort(), [
      "0.1.0-eeeeeeeeeeee",
      "0.2.0-not-a-hash",
      "0.3.0-dddddddddddd",
      "My Project",
      "notes.txt",
    ]);
  });

  it("removes a temporary folder only once its process is gone", () => {
    const appRoot = freshDir("temporaries");
    const keep = unpackedVersion(appRoot, "0.3.0-dddddddddddd");
    const live = 4242;
    for (const name of [`0.3.0-dddddddddddd.tmp-${live}`, `0.3.0-dddddddddddd.tmp-${DEAD}`]) {
      unpackedVersion(appRoot, name, false);
    }
    const removed = pruneOtherVersions(appRoot, keep, { isAlive: (pid) => pid === live });
    assert.deepEqual(removed, [`0.3.0-dddddddddddd.tmp-${DEAD}`]);
    assert.ok(fs.existsSync(path.join(appRoot, `0.3.0-dddddddddddd.tmp-${live}`)));
  });

  it("finishes off folders left half-deleted", () => {
    const appRoot = freshDir("half-deleted");
    const keep = unpackedVersion(appRoot, "0.3.0-dddddddddddd");
    unpackedVersion(appRoot, "0.2.0-cccccccccccc.del-77-abcdef", false);
    assert.deepEqual(pruneOtherVersions(appRoot, keep, nobodyAlive), ["0.2.0-cccccccccccc.del-77-abcdef"]);
    assert.deepEqual(fs.readdirSync(appRoot), ["0.3.0-dddddddddddd"]);
  });

  it("never follows a link", { skip: process.platform === "win32" }, () => {
    const appRoot = freshDir("links");
    const keep = unpackedVersion(appRoot, "0.3.0-dddddddddddd");
    const elsewhere = unpackedVersion(freshDir("link-target"), "precious");
    fs.symlinkSync(elsewhere, path.join(appRoot, "0.1.0-ffffffffffff"));
    assert.deepEqual(pruneOtherVersions(appRoot, keep, nobodyAlive), []);
    assert.ok(fs.existsSync(path.join(elsewhere, "nested", "file.js")));
  });

  it("is a no-op when the app folder does not exist yet", () => {
    assert.deepEqual(pruneOtherVersions(path.join(tmpRoot, "never-created"), "irrelevant"), []);
  });
});

describe("resetAppCache", () => {
  it("removes every unpacked copy, the current one included, and nothing else", () => {
    const appRoot = freshDir("reset");
    unpackedVersion(appRoot, "0.3.0-dddddddddddd");
    unpackedVersion(appRoot, "0.2.0-cccccccccccc");
    fs.mkdirSync(path.join(appRoot, "My Project"));
    fs.writeFileSync(path.join(appRoot, "notes.txt"), "mine");
    assert.deepEqual(resetAppCache(appRoot, nobodyAlive), ["0.2.0-cccccccccccc", "0.3.0-dddddddddddd"]);
    assert.deepEqual(fs.readdirSync(appRoot).sort(), ["My Project", "notes.txt"]);
  });
});

describe("discardDir", () => {
  it("moves a folder aside under a name that says so, then deletes it", () => {
    const appRoot = freshDir("discard");
    const dir = unpackedVersion(appRoot, "0.3.0-dddddddddddd");
    assert.equal(discardDir(dir), true);
    assert.deepEqual(fs.readdirSync(appRoot), []);
  });

  it("counts a folder that is already gone as discarded", () => {
    assert.equal(discardDir(path.join(tmpRoot, "not-there")), true);
  });
});
