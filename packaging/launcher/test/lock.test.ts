import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { acquireLock, LockTimeoutError, type LockOwner } from "../src/lock.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-lock-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let counter = 0;
const lockPath = () => path.join(tmpRoot, `test-${++counter}.lock`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A lock file as another launcher would have written it. */
function plant(file: string, owner: Partial<LockOwner>): void {
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: 4242, nonce: "someone-else", startedAt: Date.now(), ...owner })
  );
}

describe("acquireLock", () => {
  it("creates the lock, naming this process, and removes it on release", async () => {
    const file = lockPath();
    const held = await acquireLock(file);
    const owner = JSON.parse(fs.readFileSync(file, "utf-8")) as LockOwner;
    assert.equal(owner.pid, process.pid);
    held.release();
    assert.equal(fs.existsSync(file), false);
    held.release(); // A second release is harmless.
  });

  it("is readable by its owner only", { skip: process.platform === "win32" }, async () => {
    const file = lockPath();
    const held = await acquireLock(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    held.release();
  });

  it("makes a second taker wait until the first has finished", async () => {
    const file = lockPath();
    const first = await acquireLock(file);
    const waitedFor: (LockOwner | null)[] = [];
    let secondHeld = false;
    const second = acquireLock(file, {
      pollMs: 20,
      onWait: (owner) => waitedFor.push(owner),
    }).then((held) => {
      secondHeld = true;
      return held;
    });
    await sleep(150);
    assert.equal(secondHeld, false, "the second took a lock that was still held");
    first.release();
    (await second).release();
    assert.equal(secondHeld, true);
    assert.equal(waitedFor.length, 1, "says once that it is waiting");
    assert.equal(waitedFor[0]?.pid, process.pid);
  });

  it("takes over a lock whose process is gone", async () => {
    const file = lockPath();
    plant(file, { pid: 4242 });
    let waited = false;
    const held = await acquireLock(file, {
      isAlive: () => false,
      waitMs: 1000,
      onWait: () => (waited = true),
    });
    assert.equal(waited, false);
    assert.equal((JSON.parse(fs.readFileSync(file, "utf-8")) as LockOwner).pid, process.pid);
    held.release();
  });

  it("takes over a lock older than the stale limit even if its process id is in use", async () => {
    const file = lockPath();
    plant(file, { startedAt: Date.now() - 60_000 });
    const held = await acquireLock(file, { isAlive: () => true, staleAfterMs: 30_000, waitMs: 1000 });
    held.release();
  });

  it("waits for a lock that is still being written, then takes it if it never is", async () => {
    const file = lockPath();
    fs.writeFileSync(file, "");
    await assert.rejects(
      acquireLock(file, { waitMs: 100, pollMs: 20 }),
      (e: unknown) => e instanceof LockTimeoutError
    );
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const held = await acquireLock(file, { waitMs: 1000 });
    held.release();
  });

  it("gives up with LockTimeoutError, naming the owner, while a live owner keeps it", async () => {
    const file = lockPath();
    plant(file, { pid: 4242 });
    await assert.rejects(
      acquireLock(file, { isAlive: () => true, waitMs: 100, pollMs: 20 }),
      (e: unknown) => e instanceof LockTimeoutError && e.owner?.pid === 4242
    );
    assert.ok(fs.existsSync(file), "a live owner's lock was removed");
  });

  it("leaves a lock alone on release once someone else has replaced it", async () => {
    const file = lockPath();
    const held = await acquireLock(file);
    plant(file, { pid: 4242, nonce: "the-new-owner" });
    held.release();
    assert.equal((JSON.parse(fs.readFileSync(file, "utf-8")) as LockOwner).nonce, "the-new-owner");
  });

  it("lets exactly one of many simultaneous takers hold it at a time", async () => {
    const file = lockPath();
    let holders = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const held = await acquireLock(file, { pollMs: 5 });
        holders++;
        most = Math.max(most, holders);
        await sleep(10);
        holders--;
        held.release();
      })
    );
    assert.equal(most, 1);
    assert.equal(fs.existsSync(file), false);
  });
});
