/**
 * The sign-in routes, called the way the server calls them.
 */
import { TEST_PASSWORD } from "./test-support/isolated-env";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { resetRateLimits } from "./rate-limit";
import { verifySessionToken } from "./auth";

const BASE = "http://localhost:3000";

const loginRequest = (password: string) =>
  new NextRequest(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ password }),
  });

const sessionCookie = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

beforeEach(() => resetRateLimits());

describe("POST /api/auth/login", () => {
  it("signs in with the password", async () => {
    const res = await login(loginRequest(TEST_PASSWORD));
    assert.equal(res.status, 200);
    assert.equal(await verifySessionToken(sessionCookie(res).split("=")[1]), true);
  });

  it("checks no more than five guesses when a hundred arrive at once", async () => {
    const statuses = await Promise.all(
      Array.from({ length: 100 }, (_, i) => login(loginRequest(`wrong-${i}`)).then((r) => r.status))
    );
    assert.equal(statuses.filter((s) => s === 401).length, 5);
    assert.equal(statuses.filter((s) => s === 429).length, 95);
  });

  it("refuses even the right password once the limit is reached", async () => {
    for (let i = 0; i < 5; i++) await login(loginRequest(`wrong-${i}`));
    assert.equal((await login(loginRequest(TEST_PASSWORD))).status, 429);
  });

  it("doesn't hold earlier typos against a correct sign-in", async () => {
    for (let i = 0; i < 4; i++) await login(loginRequest(`typo-${i}`));
    assert.equal((await login(loginRequest(TEST_PASSWORD))).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await login(loginRequest(`typo-again-${i}`))).status, 401);
  });
});

describe("POST /api/auth/logout", () => {
  it("ends the session for good", async () => {
    const cookie = sessionCookie(await login(loginRequest(TEST_PASSWORD)));
    const res = await logout(
      new NextRequest(`${BASE}/api/auth/logout`, { method: "POST", headers: { origin: BASE, cookie } })
    );
    assert.equal(res.status, 200);
    assert.equal(await verifySessionToken(cookie.split("=")[1]), false);
  });
});
