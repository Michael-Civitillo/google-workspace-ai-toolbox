import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  expectedProof,
  findFreePort,
  findRunningInstance,
  generateInstanceToken,
  INSTANCE_PROOF_LABEL,
  isAddressTaken,
  isPortAvailable,
  isPortFree,
  otherLoopbacks,
  PORT_FALLBACK_SPAN,
  proofMatches,
  readLock,
  removeOwnLock,
  verifyInstance,
  writeLock,
  type LockRecord,
} from "../src/instance.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-instance-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** Listen on a free loopback port; resolves with the server and its port. */
async function listen(
  handler: http.RequestListener
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    server,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** What src/lib/launch-tickets.ts computes, written out independently. */
function serverSideProof(token: string, challenge: string): string {
  return createHmac("sha256", token).update(INSTANCE_PROOF_LABEL + challenge).digest("hex");
}

/** A stand-in for the app: answers /login, and the proof for `token` if given. */
function fakeApp(token: string | null, seen: string[] = []) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    seen.push(`${req.method} ${req.url}`);
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>sign in</html>");
      return;
    }
    if (url.pathname === "/api/auth/launch-ticket" && req.method === "GET" && token) {
      const challenge = url.searchParams.get("challenge") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ proof: serverSideProof(token, challenge) }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"Not found"}');
  };
}

describe("instance token and proof", () => {
  it("generates a fresh 64-character lower-case hex token each time", () => {
    const a = generateInstanceToken();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, generateInstanceToken());
  });

  it("computes the same proof as the server: HMAC-SHA256 keyed by the token text", () => {
    const token = generateInstanceToken();
    const challenge = "ab".repeat(32);
    assert.equal(expectedProof(token, challenge).toString("hex"), serverSideProof(token, challenge));
    assert.equal(proofMatches(token, challenge, serverSideProof(token, challenge)), true);
  });

  it("rejects a proof made with another token, for another challenge, or malformed", () => {
    const token = generateInstanceToken();
    const challenge = "cd".repeat(32);
    assert.equal(proofMatches(token, challenge, serverSideProof(generateInstanceToken(), challenge)), false);
    assert.equal(proofMatches(token, challenge, serverSideProof(token, "ef".repeat(32))), false);
    for (const junk of [undefined, null, 42, "", "zz".repeat(32), "ab".repeat(31), "AB".repeat(32)]) {
      assert.equal(proofMatches(token, challenge, junk), false, `accepted ${String(junk)}`);
    }
  });
});

describe("launcher.lock", () => {
  const record = (overrides: Partial<LockRecord> = {}): LockRecord => ({
    pid: process.pid,
    port: 3000,
    host: "127.0.0.1",
    startedAt: "2026-01-01T00:00:00.000Z",
    token: generateInstanceToken(),
    ...overrides,
  });

  it("round-trips the record, token included", () => {
    const file = path.join(tmpRoot, "round-trip.lock");
    const written = record();
    writeLock(file, written);
    assert.deepEqual(readLock(file), written);
  });

  it("is readable by its owner only", { skip: process.platform === "win32" }, () => {
    const file = path.join(tmpRoot, "mode.lock");
    writeLock(file, record());
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("reads a lock from an older launcher, or with a malformed token, as having no token", () => {
    const file = path.join(tmpRoot, "old.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: 1, port: 3000, host: "127.0.0.1", startedAt: "" }));
    assert.equal(readLock(file)?.token, null);
    fs.writeFileSync(file, JSON.stringify({ pid: 1, port: 3000, token: "not-hex" }));
    assert.equal(readLock(file)?.token, null);
  });

  it("removes the lock only when it is this process's own", () => {
    const file = path.join(tmpRoot, "own.lock");
    const mine = record();
    writeLock(file, mine);
    removeOwnLock(file, generateInstanceToken());
    assert.ok(fs.existsSync(file), "removed a lock carrying another token");
    writeLock(file, { ...mine, pid: process.pid + 100000 });
    removeOwnLock(file, mine.token ?? "");
    assert.ok(fs.existsSync(file), "removed a lock written by another process");
    writeLock(file, mine);
    removeOwnLock(file, mine.token ?? "");
    assert.equal(fs.existsSync(file), false);
  });
});

describe("verifyInstance", () => {
  it("accepts a server that knows the token, with a fresh challenge every time", async () => {
    const token = generateInstanceToken();
    const seen: string[] = [];
    const app = await listen(fakeApp(token, seen));
    try {
      assert.equal(await verifyInstance("127.0.0.1", app.port, token), true);
      assert.equal(await verifyInstance("127.0.0.1", app.port, token), true);
      const challenges = seen.map((s) => s.match(/challenge=([0-9a-f]+)/)?.[1]);
      assert.equal(challenges.length, 2);
      assert.match(challenges[0] ?? "", /^[0-9a-f]{64}$/);
      assert.notEqual(challenges[0], challenges[1]);
    } finally {
      await app.close();
    }
  });

  it("refuses a server that answers with another token's proof, a 404 or junk", async () => {
    const token = generateInstanceToken();
    for (const handler of [
      fakeApp(generateInstanceToken()),
      fakeApp(null),
      (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("<html>hello</html>"),
      (_req: http.IncomingMessage, res: http.ServerResponse) => res.end('{"proof":"' + "0".repeat(64) + '"}'),
    ]) {
      const app = await listen(handler);
      try {
        assert.equal(await verifyInstance("127.0.0.1", app.port, token), false);
      } finally {
        await app.close();
      }
    }
  });

  it("asks nothing when it has no valid token to check against", async () => {
    const seen: string[] = [];
    const app = await listen(fakeApp(null, seen));
    try {
      assert.equal(await verifyInstance("127.0.0.1", app.port, "short"), false);
      assert.deepEqual(seen, []);
    } finally {
      await app.close();
    }
  });
});

describe("findRunningInstance", () => {
  const lockAt = (name: string, rec: Partial<LockRecord>) => {
    const file = path.join(tmpRoot, name);
    fs.writeFileSync(file, JSON.stringify(rec));
    return file;
  };
  const ok = { probe: async () => 200 };

  it("finds nothing without a lock, with a dead process, or when nothing answers", async () => {
    assert.deepEqual(await findRunningInstance(path.join(tmpRoot, "absent.lock")), { kind: "none" });
    const file = lockAt("dead.lock", { pid: 1234, port: 3000, token: generateInstanceToken() });
    assert.deepEqual(
      await findRunningInstance(file, { ...ok, isAlive: () => false }),
      { kind: "none" }
    );
    assert.deepEqual(
      await findRunningInstance(file, { isAlive: () => true, probe: async () => null }),
      { kind: "none" }
    );
  });

  it("calls it ours only when the server proves it knows the lock's token", async () => {
    const token = generateInstanceToken();
    const file = lockAt("ours.lock", { pid: 1234, port: 3000, host: "127.0.0.1", token });
    const asked: string[] = [];
    const found = await findRunningInstance(file, {
      ...ok,
      isAlive: () => true,
      verify: async (_h, _p, t) => {
        asked.push(t);
        return true;
      },
    });
    assert.deepEqual(found, { kind: "ours", host: "127.0.0.1", port: 3000 });
    assert.deepEqual(asked, [token]);
  });

  it("does not trust a live process whose port fails the proof, or a lock with no token", async () => {
    const withToken = lockAt("foreign.lock", { pid: 1234, port: 3000, token: generateInstanceToken() });
    assert.equal(
      (await findRunningInstance(withToken, { ...ok, isAlive: () => true, verify: async () => false })).kind,
      "unverified"
    );
    let verified = false;
    const old = lockAt("old-version.lock", { pid: 1234, port: 3000 });
    const found = await findRunningInstance(old, {
      ...ok,
      isAlive: () => true,
      verify: async () => (verified = true),
    });
    assert.deepEqual(found, { kind: "unverified", pid: 1234, host: "127.0.0.1", port: 3000 });
    assert.equal(verified, false, "a lock without a token must not even be checked");
  });

  it("with a stale lock naming a live process, never takes another program for itself", async () => {
    // The case that used to hand over the password: the process in the lock
    // is alive (here, this test) and some other program answers on its port.
    const seen: string[] = [];
    const other = await listen(fakeApp(null, seen));
    try {
      const file = lockAt("stale.lock", {
        pid: process.pid,
        port: other.port,
        host: "127.0.0.1",
        token: generateInstanceToken(),
      });
      const found = await findRunningInstance(file);
      assert.equal(found.kind, "unverified");
      assert.ok(seen.every((s) => s.startsWith("GET ")), `sent more than probes: ${seen.join(", ")}`);
    } finally {
      await other.close();
    }
  });

  it("recognises the real thing end to end", async () => {
    const token = generateInstanceToken();
    const app = await listen(fakeApp(token));
    try {
      const file = lockAt("real.lock", { pid: process.pid, port: app.port, host: "127.0.0.1", token });
      assert.deepEqual(await findRunningInstance(file), { kind: "ours", host: "127.0.0.1", port: app.port });
    } finally {
      await app.close();
    }
  });
});

describe("isPortAvailable", () => {
  const free = async () => true;

  it("also checks the other loopback address when the server is for this machine", async () => {
    const asked: string[] = [];
    const isTaken = async (address: string) => {
      asked.push(address);
      return address === "::1";
    };
    assert.equal(await isPortAvailable("127.0.0.1", 3000, { isFree: free, isTaken }), false);
    assert.deepEqual(asked, ["::1"]);
    assert.equal(await isPortAvailable("::1", 3000, { isFree: free, isTaken: async () => false }), true);
  });

  it("checks both loopback addresses for localhost, and neither for another address", async () => {
    assert.deepEqual(otherLoopbacks("localhost"), ["127.0.0.1", "::1"]);
    assert.deepEqual(otherLoopbacks("::1"), ["127.0.0.1"]);
    let asked = 0;
    const isTaken = async () => {
      asked++;
      return true;
    };
    assert.equal(await isPortAvailable("0.0.0.0", 3000, { isFree: free, isTaken }), true);
    assert.equal(await isPortAvailable("192.168.1.10", 3000, { isFree: free, isTaken }), true);
    assert.equal(asked, 0);
  });

  it("is false when the port itself cannot be bound", async () => {
    assert.equal(
      await isPortAvailable("127.0.0.1", 3000, { isFree: async () => false, isTaken: async () => false }),
      false
    );
  });

  it("sees a real listener, and treats an address this machine lacks as holding nothing", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const port = (holder.address() as net.AddressInfo).port;
    try {
      assert.equal(await isAddressTaken("127.0.0.1", port), true);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
    assert.equal(await isAddressTaken("127.0.0.1", port), false);
    // TEST-NET-1 is never configured on a real interface.
    assert.equal(await isAddressTaken("192.0.2.1", port, 300), false);
  });

  it("refuses a port when another program listens on ::1 there", async (t) => {
    const holder = net.createServer();
    const listening = await new Promise<boolean>((resolve) => {
      holder.once("error", () => resolve(false));
      holder.listen(0, "::1", () => resolve(true));
    });
    if (!listening) {
      t.skip("no IPv6 loopback on this machine");
      return;
    }
    const port = (holder.address() as net.AddressInfo).port;
    try {
      assert.equal(await isPortFree("127.0.0.1", port), true, "precondition: 127.0.0.1 is free");
      assert.equal(await isPortAvailable("127.0.0.1", port), false);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});

/** A probe that reports the given ports as taken and records what it was asked. */
function probe(busy: number[]) {
  const asked: number[] = [];
  const isFree = async (_host: string, port: number) => {
    asked.push(port);
    return !busy.includes(port);
  };
  return { asked, isFree };
}

describe("findFreePort", () => {
  it("returns the first port when it is free", async () => {
    const { asked, isFree } = probe([]);
    assert.equal(await findFreePort("127.0.0.1", 3001, 20, isFree), 3001);
    assert.deepEqual(asked, [3001]);
  });

  it("skips busy ports in order", async () => {
    const { asked, isFree } = probe([3001, 3002]);
    assert.equal(await findFreePort("127.0.0.1", 3001, 20, isFree), 3003);
    assert.deepEqual(asked, [3001, 3002, 3003]);
  });

  it("gives up after the span rather than scanning forever", async () => {
    const { asked, isFree } = probe([3001, 3002, 3003]);
    assert.equal(await findFreePort("127.0.0.1", 3001, 3, isFree), null);
    assert.deepEqual(asked, [3001, 3002, 3003]);
  });

  it("tries PORT_FALLBACK_SPAN ports when no span is given", async () => {
    const { asked, isFree } = probe(Array.from({ length: 200 }, (_, i) => 3001 + i));
    assert.equal(await findFreePort("127.0.0.1", 3001, undefined, isFree), null);
    assert.equal(asked.length, PORT_FALLBACK_SPAN);
  });

  it("never probes past the last valid port", async () => {
    const { asked, isFree } = probe([65534, 65535]);
    assert.equal(await findFreePort("127.0.0.1", 65534, 20, isFree), null);
    assert.deepEqual(asked, [65534, 65535]);
  });

  it("finds a real free port next to one that is really taken", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const taken = (holder.address() as net.AddressInfo).port;
    try {
      assert.equal(await isPortFree("127.0.0.1", taken), false);
      const found = await findFreePort("127.0.0.1", taken);
      assert.ok(found !== null && found > taken, `expected a port above ${taken}, got ${found}`);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});
