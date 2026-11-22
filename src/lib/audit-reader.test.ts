import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  decodeAuditCursor,
  encodeAuditCursor,
  readAuditLogPage,
  type AuditCursor,
  type AuditLogFilters,
} from "./audit-reader";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-reader-test-"));
let dir: string;
let logPath: string;
let run = 0;

beforeEach(() => {
  dir = path.join(root, `case-${++run}`);
  fs.mkdirSync(dir);
  logPath = path.join(dir, "audit.log");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-01T00:00:00.000Z");

/** One audit line; `n` doubles as a minute offset from T0 and an id. */
function entry(n: number, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      ts: new Date(T0 + n * 60_000).toISOString(),
      action: "test.action",
      tenantId: "t1",
      tenantName: "Tenant one",
      params: { n },
      outcome: "success",
      ...extra,
    }) + "\n"
  );
}

function write(file: string, ns: number[], extra: Record<string, unknown> = {}) {
  fs.writeFileSync(file, ns.map((n) => entry(n, extra)).join(""));
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Walk the whole log, as the Audit Log page does, collecting entry ids. */
async function walk(filters: AuditLogFilters = {}, maxEntries = 500) {
  const ns: number[] = [];
  let cursor: AuditCursor | null = null;
  let calls = 0;
  let last;
  do {
    last = await readAuditLogPage({ cursor, maxEntries, filters, logPath });
    for (const e of last.entries) ns.push((e.params as { n: number }).n);
    cursor = last.nextCursor;
    if (++calls > 1000) throw new Error("walk did not finish");
  } while (!last.done);
  return { ns, calls, last };
}

describe("audit reader", () => {
  it("has nothing to show before anything is logged", async () => {
    const page = await readAuditLogPage({ logPath });
    assert.equal(page.done, true);
    assert.deepEqual(page.entries, []);
    assert.equal(page.nextCursor, null);
  });

  it("returns entries newest first across several windows", async () => {
    // ~3,000 lines of ~200 bytes: more than one 512 KB window.
    write(logPath, range(1, 3000));
    const { ns, calls } = await walk();
    assert.ok(calls > 1, "needed more than one window");
    assert.deepEqual(ns, range(1, 3000).reverse());
  });

  it("reads the rotated archives too, oldest last", async () => {
    write(`${logPath}.3`, range(1, 10));
    write(`${logPath}.2`, range(11, 20));
    write(`${logPath}.1`, range(21, 30));
    write(logPath, range(31, 40));
    const { ns, last } = await walk();
    assert.deepEqual(ns, range(1, 40).reverse());
    assert.equal(last.reachedFromBound, false);
  });

  it("still reads an archive when one before it is missing", async () => {
    write(`${logPath}.2`, range(1, 5));
    write(logPath, range(6, 10));
    const { ns } = await walk();
    assert.deepEqual(ns, range(1, 10).reverse());
  });

  it("is not done until the oldest archive has been read", async () => {
    write(`${logPath}.1`, range(1, 5));
    write(logPath, range(6, 10));
    const first = await readAuditLogPage({ logPath, maxEntries: 500 });
    assert.equal(first.done, false, "the live file is finished, the archive is not");
    assert.deepEqual(
      first.entries.map((e) => (e.params as { n: number }).n),
      range(6, 10).reverse()
    );
    const second = await readAuditLogPage({ logPath, cursor: first.nextCursor });
    assert.equal(second.done, true);
    assert.deepEqual(
      second.entries.map((e) => (e.params as { n: number }).n),
      range(1, 5).reverse()
    );
  });

  it("keeps following its file when the log rotates between calls", async () => {
    write(logPath, range(1, 3000));
    const first = await readAuditLogPage({ logPath, maxEntries: 100 });
    assert.equal(first.done, false);
    const seen = first.entries.map((e) => (e.params as { n: number }).n);

    // Rotate: the file being read becomes audit.log.1 and a new live file
    // collects newer entries.
    fs.renameSync(logPath, `${logPath}.1`);
    write(logPath, range(5000, 5010));

    let cursor = first.nextCursor;
    let page;
    do {
      page = await readAuditLogPage({ logPath, cursor, maxEntries: 500 });
      assert.equal(page.restarted, false);
      for (const e of page.entries) seen.push((e.params as { n: number }).n);
      cursor = page.nextCursor;
    } while (!page.done);
    assert.deepEqual(seen, range(1, 3000).reverse(), "no newer entry handed back as older");
  });

  it("starts again from the newest entry when the cursor's file is gone", async () => {
    write(logPath, range(1, 3000));
    const first = await readAuditLogPage({ logPath, maxEntries: 50 });
    // The file rotated off the end of the archives.
    fs.rmSync(logPath);
    write(logPath, range(9000, 9004));
    const page = await readAuditLogPage({ logPath, cursor: first.nextCursor });
    assert.equal(page.restarted, true);
    assert.deepEqual(
      page.entries.map((e) => (e.params as { n: number }).n),
      range(9000, 9004).reverse()
    );
  });

  it("starts again when the file is shorter than the cursor", async () => {
    write(logPath, range(1, 3000));
    const first = await readAuditLogPage({ logPath, maxEntries: 50 });
    assert.ok(first.nextCursor);
    // Truncated by hand to its first few lines: same first line, so the same
    // identity, but the offset now points past the end.
    write(logPath, range(1, 3));
    const page = await readAuditLogPage({ logPath, cursor: first.nextCursor });
    assert.equal(page.restarted, true);
    assert.deepEqual(
      page.entries.map((e) => (e.params as { n: number }).n),
      [3, 2, 1]
    );
  });

  it("applies the filters", async () => {
    fs.writeFileSync(
      logPath,
      [
        entry(1, { action: "groups.member_add", tenantId: "t1" }),
        entry(2, { action: "groups.member_remove", tenantId: "t2" }),
        entry(3, { action: "offboarding.suspend", outcome: "error", tenantId: "t1" }),
        entry(4, { action: "GROUPS.MEMBER_ADD", tenantId: "t1" }),
      ].join("")
    );
    assert.deepEqual((await walk({ action: "member_add" })).ns, [4, 1]);
    assert.deepEqual((await walk({ outcome: "error" })).ns, [3]);
    assert.deepEqual((await walk({ tenantId: "t2" })).ns, [2]);
    assert.deepEqual(
      (await walk({ toMs: T0 + 2 * 60_000 })).ns,
      [2, 1],
      "the upper bound is inclusive"
    );
  });

  it("does not stop at a single entry older than the From date", async () => {
    // A clock stepped back an hour, then corrected: one entry looks older
    // than everything around it.
    fs.writeFileSync(
      logPath,
      [entry(100), entry(101), entry(-60), entry(102), entry(103)].join("")
    );
    const { ns, last } = await walk({ fromMs: T0 + 100 * 60_000 });
    assert.deepEqual(ns, [103, 102, 101, 100]);
    assert.equal(last.reachedFromBound, false, "read to the start of the log");
  });

  it("stops early once it is well past the From date", async () => {
    write(`${logPath}.1`, range(1, 1000));
    write(logPath, range(1001, 1010));
    const { ns, last } = await walk({ fromMs: T0 + 1005 * 60_000 });
    assert.deepEqual(ns, range(1005, 1010).reverse());
    assert.equal(last.done, true);
    assert.equal(last.reachedFromBound, true, "did not read the whole archive");
  });

  it("says how far back it has read, matched or not", async () => {
    write(logPath, range(1, 10));
    const page = await readAuditLogPage({ logPath, filters: { action: "nothing" } });
    assert.deepEqual(page.entries, []);
    assert.equal(page.oldestScannedTs, new Date(T0 + 60_000).toISOString());
  });

  it("skips lines that are not entries", async () => {
    fs.writeFileSync(
      logPath,
      [entry(1), "not json\n", "[1,2]\n", "\n", entry(2)].join("")
    );
    const page = await readAuditLogPage({ logPath });
    assert.deepEqual(
      page.entries.map((e) => (e.params as { n: number }).n),
      [2, 1]
    );
    assert.equal(page.skippedLines, 2);
  });
});

describe("audit cursors", () => {
  it("round-trip through a query parameter", () => {
    const c = { file: "AbC_-123456789012345678", offset: 524288 };
    assert.deepEqual(decodeAuditCursor(encodeAuditCursor(c)), c);
  });

  it("refuse anything else", () => {
    for (const bad of ["", "12345", "short:1", "abcdefghij:-1", "abcdefghij:1.5", "abc def ghij:1", "abcdefghij:9999999999999999"]) {
      assert.equal(decodeAuditCursor(bad), null, bad);
    }
  });
});
