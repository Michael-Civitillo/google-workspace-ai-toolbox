/**
 * The audit log writer: what an entry may contain, and rotation.
 */
import { TEST_DATA_DIR } from "./test-support/isolated-env";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { audit, AUDIT_LOG_PATH, boundedParams, preparedEntry, resetAuditWriterState } from "./audit";

const entry = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    action: "test.action",
    tenantId: "t1",
    tenantName: "Test",
    params,
    outcome: "error" as const,
    ...extra,
  });

const lines = () =>
  fs.existsSync(AUDIT_LOG_PATH)
    ? fs.readFileSync(AUDIT_LOG_PATH, "utf-8").trim().split("\n").filter(Boolean)
    : [];

function clearLogs() {
  for (const name of fs.readdirSync(TEST_DATA_DIR)) {
    if (name.startsWith("audit.log")) fs.rmSync(path.join(TEST_DATA_DIR, name), { recursive: true, force: true });
  }
}

describe("what an entry may contain", () => {
  it("writes the log inside the isolated test folder", () => {
    assert.equal(path.dirname(AUDIT_LOG_PATH), TEST_DATA_DIR);
  });

  it("keeps an ordinary entry exactly as given", () => {
    const params = { user: "jane@example.com", count: 3, ok: true, list: ["a", "b"], nested: { x: 1 } };
    const out = preparedEntry(entry(params, { actor: "password-session", error: "nope" }), "T");
    assert.deepEqual(out.params, params);
    assert.equal(out.action, "test.action");
    assert.equal(out.actor, "password-session");
    assert.equal(out.error, "nope");
  });

  it("still redacts secrets, by key, at any depth", () => {
    const out = preparedEntry(entry({ password: "x", nested: { clientSecret: "y", list: [{ api_key: "z" }] } }), "T");
    assert.deepEqual(out.params, { password: "[redacted]", nested: { clientSecret: "[redacted]", list: [{ api_key: "[redacted]" }] } });
  });

  it("cuts a multi-megabyte value down to a short one", () => {
    const line = JSON.stringify(preparedEntry(entry({ user: "A".repeat(8 * 1024 * 1024) }), "T"));
    assert.ok(line.length < 2_000, `${line.length} bytes`);
    assert.match(line, /\[8388608 chars\]/);
  });

  it("cuts a multi-megabyte key name, long lists and deep nesting", () => {
    const out = preparedEntry(
      entry({
        ["k".repeat(1_000_000)]: 1,
        list: Array.from({ length: 5_000 }, (_, i) => i),
        deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
      }),
      "T"
    );
    const json = JSON.stringify(out);
    assert.ok(json.length < 4_000, `${json.length} bytes`);
    assert.match(json, /… 4950 more/);
    assert.match(json, /nested too deep/);
  });

  it("keeps the small fields and drops the bulk when the whole is still too big", () => {
    const out = preparedEntry(
      entry({
        user: "jane@example.com",
        removed: 7,
        failures: Array.from({ length: 50 }, (_, i) => ({ id: `file-${i}`, message: "x".repeat(900) })),
      }),
      "T"
    );
    const params = out.params as Record<string, unknown>;
    assert.equal(params.user, "jane@example.com");
    assert.equal(params.removed, 7);
    assert.match(String(params.failures), /^\[omitted: \d+ bytes\]$/);
    assert.ok(JSON.stringify(out).length < 17 * 1024);
  });

  it("bounds the entry's own text fields", () => {
    const out = preparedEntry(
      entry({}, { action: "a".repeat(10_000), tenantName: "n".repeat(10_000), actor: "x".repeat(10_000), error: "e".repeat(100_000) }),
      "T"
    );
    assert.ok(JSON.stringify(out).length < 4_000);
  });

  it("boundedParams cuts long key names too", () => {
    const out = boundedParams({ ["k".repeat(1_000_000)]: "v" });
    assert.ok(Object.keys(out)[0].length < 100);
  });
});

describe("rotation", () => {
  const EIGHT_MB = 8 * 1024 * 1024;
  const archive = (n: number) => `${AUDIT_LOG_PATH}.${n}`;
  const first = (file: string) => fs.readFileSync(file, "utf-8").split("\n")[0];

  beforeEach(() => {
    clearLogs();
    resetAuditWriterState();
    fs.writeFileSync(AUDIT_LOG_PATH, "LIVE\n" + "x".repeat(EIGHT_MB));
    fs.writeFileSync(archive(1), "ONE\n");
    fs.writeFileSync(archive(2), "TWO\n");
    fs.writeFileSync(archive(3), "THREE\n");
  });
  afterEach(() => {
    mock.restoreAll();
    clearLogs();
  });

  it("shifts every archive along and drops the oldest", () => {
    audit(entry({ n: 1 }));
    // Proof the rotation ran: the live file is new.
    assert.notEqual(first(AUDIT_LOG_PATH), "LIVE");
    assert.equal(first(archive(1)), "LIVE");
    assert.equal(first(archive(2)), "ONE");
    assert.equal(first(archive(3)), "TWO");
    assert.equal(lines().length, 1);
    assert.deepEqual(
      fs.readdirSync(TEST_DATA_DIR).filter((n) => n.startsWith("audit.log")).sort(),
      ["audit.log", "audit.log.1", "audit.log.2", "audit.log.3"]
    );
  });

  it("changes nothing when the live file can't be moved, and keeps appending to it", () => {
    const real = fs.renameSync;
    mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === AUDIT_LOG_PATH) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return real(from, to);
    });
    audit(entry({ n: 1 }));
    const fsMock = (fs.renameSync as unknown as { mock: { calls: unknown[] } }).mock;
    assert.equal(fsMock.calls.length, 1, "only the live file's move was tried");
    assert.equal(first(AUDIT_LOG_PATH), "LIVE");
    assert.equal(first(archive(1)), "ONE");
    assert.equal(first(archive(2)), "TWO");
    assert.equal(first(archive(3)), "THREE");
    assert.match(fs.readFileSync(AUDIT_LOG_PATH, "utf-8"), /"n":1/);
  });

  it("puts everything back when a later step fails, losing no archive", () => {
    const real = fs.renameSync;
    mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === archive(1)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return real(from, to);
    });
    audit(entry({ n: 1 }));
    // Proof the rotation was attempted and got past the first steps.
    const fsMock = (fs.renameSync as unknown as { mock: { calls: unknown[] } }).mock;
    assert.ok(fsMock.calls.length >= 3, `${fsMock.calls.length} renames`);
    assert.equal(first(AUDIT_LOG_PATH), "LIVE");
    assert.equal(first(archive(1)), "ONE");
    assert.equal(first(archive(2)), "TWO");
    assert.equal(first(archive(3)), "THREE");
    assert.deepEqual(
      fs.readdirSync(TEST_DATA_DIR).filter((n) => n.startsWith("audit.log")).sort(),
      ["audit.log", "audit.log.1", "audit.log.2", "audit.log.3"]
    );
  });
});
