import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
  browsableUrl,
  isUnspecifiedHost,
  normalizeHost,
  reachableHost,
  urlHost,
} from "../src/address.ts";
import { waitUntilReady } from "../src/server.ts";

describe("normalizeHost", () => {
  it("takes the brackets off an IPv6 address typed the URL way", () => {
    assert.equal(normalizeHost("[::1]"), "::1");
    assert.equal(normalizeHost("[2001:db8::5]"), "2001:db8::5");
  });

  it("leaves everything else alone", () => {
    for (const host of ["127.0.0.1", "::1", "0.0.0.0", "admin.example.com", "[]"]) {
      assert.equal(normalizeHost(host), host);
    }
    assert.equal(normalizeHost(" 127.0.0.1 "), "127.0.0.1");
  });
});

describe("reachableHost", () => {
  it("reaches a server bound to every address over loopback", () => {
    assert.equal(isUnspecifiedHost("0.0.0.0"), true);
    assert.equal(isUnspecifiedHost("::"), true);
    assert.equal(reachableHost("0.0.0.0"), "127.0.0.1");
    assert.equal(reachableHost("::"), "::1");
  });

  it("reaches any other server at its own address", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "192.168.1.10", "fe80::1"]) {
      assert.equal(isUnspecifiedHost(host), false);
      assert.equal(reachableHost(host), host);
    }
  });
});

describe("browsableUrl", () => {
  it("advertises localhost for loopback and for every-address binds", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"]) {
      assert.equal(browsableUrl(host, 3000), "http://localhost:3000", host);
    }
  });

  it("puts an IPv6 address in brackets", () => {
    assert.equal(urlHost("2001:db8::5"), "[2001:db8::5]");
    assert.equal(browsableUrl("2001:db8::5", 3000), "http://[2001:db8::5]:3000");
    assert.equal(browsableUrl("fe80::1", 8080), "http://[fe80::1]:8080");
  });

  it("uses any other address or name as it is", () => {
    assert.equal(browsableUrl("192.168.1.10", 3000), "http://192.168.1.10:3000");
    assert.equal(browsableUrl("admin.example.com", 3000), "http://admin.example.com:3000");
  });
});

describe("waitUntilReady", () => {
  it("finds a server bound to every address where reachableHost says", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      assert.equal(await waitUntilReady(reachableHost("0.0.0.0"), port, 2000), 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("names the address with brackets when it gives up on an IPv6 one", async () => {
    await assert.rejects(waitUntilReady("::1", 1, 100), /\[::1\]:1/);
  });
});
