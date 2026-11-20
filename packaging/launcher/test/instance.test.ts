import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import { findFreePort, isPortFree, PORT_FALLBACK_SPAN } from "../src/instance.ts";

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
