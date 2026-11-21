import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { historyPath, readLastScan, saveLastScan } from "./security-history";

let dir: string;
let previousDataDir: string | undefined;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "security-history-test-"));
  previousDataDir = process.env.OPEN_ADMIN_DATA_DIR;
  process.env.OPEN_ADMIN_DATA_DIR = dir;
});

after(() => {
  if (previousDataDir === undefined) delete process.env.OPEN_ADMIN_DATA_DIR;
  else process.env.OPEN_ADMIN_DATA_DIR = previousDataDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const snapshot = (keys: string[]) => ({
  completedAt: "2026-11-01T10:00:00.000Z",
  keys,
  covered: ["twoStep" as const, "apps" as const],
});

describe("security-history", () => {
  it("keeps its file in the data directory", () => {
    assert.equal(historyPath(), path.join(dir, "security-check-history.json"));
  });

  it("has nothing to offer before the first scan", () => {
    assert.equal(readLastScan("t1"), null);
  });

  it("returns what was saved", async () => {
    await saveLastScan("t1", snapshot(["2sv|a@example.com"]));
    assert.deepEqual(readLastScan("t1"), snapshot(["2sv|a@example.com"]));
  });

  it("keeps only the latest scan for a tenant", async () => {
    await saveLastScan("t1", snapshot(["2sv|a@example.com"]));
    await saveLastScan("t1", snapshot(["2sv|b@example.com"]));
    assert.deepEqual(readLastScan("t1")?.keys, ["2sv|b@example.com"]);
  });

  it("never shows one tenant another tenant's scan", async () => {
    await saveLastScan("t1", snapshot(["2sv|one@example.com"]));
    await saveLastScan("t2", snapshot(["2sv|two@example.org"]));
    assert.deepEqual(readLastScan("t1")?.keys, ["2sv|one@example.com"]);
    assert.deepEqual(readLastScan("t2")?.keys, ["2sv|two@example.org"]);
    assert.equal(readLastScan("t3"), null);
  });

  it("files a tenant-less install under its own name", async () => {
    await saveLastScan(null, snapshot(["2sv|env@example.com"]));
    assert.deepEqual(readLastScan(undefined)?.keys, ["2sv|env@example.com"]);
    assert.deepEqual(readLastScan("t1")?.keys, ["2sv|one@example.com"]);
  });

  it("treats a damaged file as no history rather than failing the scan", () => {
    fs.writeFileSync(historyPath(), "{ not json");
    assert.equal(readLastScan("t1"), null);
    fs.writeFileSync(historyPath(), JSON.stringify({ version: 1, tenants: { t1: { keys: "nope" } } }));
    assert.equal(readLastScan("t1"), null);
  });
});
