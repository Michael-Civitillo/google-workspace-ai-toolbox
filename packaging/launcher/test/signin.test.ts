import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { isLoopbackHost, requestLaunchTicket, signInUrl } from "../src/signin.ts";

interface Seen {
  method?: string;
  url?: string;
  origin?: string;
  contentType?: string;
  body: string;
}

/** A stand-in for the app's ticket endpoint whose behaviour each test sets. */
let respond: (res: http.ServerResponse) => void = (res) => res.end();
let seen: Seen[] = [];
let server: http.Server;
let port = 0;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        origin: req.headers.origin,
        contentType: req.headers["content-type"],
        body,
      });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const json = (status: number, body: unknown) => (res: http.ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const ask = (password = "the-saved-password", timeoutMs = 2000) => {
  seen = [];
  return requestLaunchTicket("127.0.0.1", port, password, `http://localhost:${port}`, timeoutMs);
};

describe("requestLaunchTicket", () => {
  it("trades the password for a ticket", async () => {
    respond = json(200, { ticket: "abc123" });
    assert.equal(await ask(), "abc123");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/api/auth/launch-ticket");
    assert.equal(seen[0].contentType, "application/json");
    assert.deepEqual(JSON.parse(seen[0].body), { password: "the-saved-password" });
  });

  it("presents the origin the browser will use, as the app's same-origin check requires", async () => {
    respond = json(200, { ticket: "abc123" });
    await ask();
    assert.equal(seen[0].origin, `http://localhost:${port}`);
  });

  it("gives up quietly when the server refuses", async () => {
    for (const refusal of [
      json(401, { error: "Invalid password" }),
      json(403, { error: "Password sign-in is turned off" }),
      json(404, { error: "Not found" }),
      json(429, { error: "Too many failed attempts" }),
    ]) {
      respond = refusal;
      assert.equal(await ask(), null);
    }
  });

  it("gives up quietly on an answer it can't use", async () => {
    respond = (res) => res.end("<html>not json</html>");
    assert.equal(await ask(), null);
    respond = json(200, { ticket: "" });
    assert.equal(await ask(), null);
    respond = json(200, { ticket: 42 });
    assert.equal(await ask(), null);
    respond = json(200, {});
    assert.equal(await ask(), null);
  });

  it("doesn't wait forever for a server that never answers", async () => {
    respond = () => {
      /* hold the connection open */
    };
    const started = Date.now();
    assert.equal(await ask("the-saved-password", 300), null);
    assert.ok(Date.now() - started < 2000);
  });

  it("returns null when nothing is listening", async () => {
    assert.equal(
      await requestLaunchTicket("127.0.0.1", 1, "pw", "http://localhost:1", 1000),
      null
    );
  });

  it("doesn't ask at all without a password to offer", async () => {
    respond = json(200, { ticket: "abc123" });
    assert.equal(await ask(""), null);
    assert.equal(seen.length, 0);
  });
});

describe("signInUrl", () => {
  it("carries the ticket to the redeeming route", () => {
    assert.equal(
      signInUrl("http://localhost:3000", "a_b-C"),
      "http://localhost:3000/api/auth/launch?ticket=a_b-C"
    );
  });

  it("escapes a ticket that isn't URL-safe", () => {
    assert.equal(
      signInUrl("http://localhost:3000", "a b&c=d"),
      "http://localhost:3000/api/auth/launch?ticket=a%20b%26c%3Dd"
    );
  });

  it("falls back to the plain address when there is no ticket", () => {
    assert.equal(signInUrl("http://localhost:3000", null), "http://localhost:3000");
  });
});

describe("isLoopbackHost", () => {
  it("is true for this machine only", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) assert.equal(isLoopbackHost(host), true);
    for (const host of ["0.0.0.0", "192.168.1.10", "admin.example.com", ""]) {
      assert.equal(isLoopbackHost(host), false);
    }
  });
});
