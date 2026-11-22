/**
 * The session check inside the routes: what still stands if a request ever
 * gets past the request gate.
 */
import "./test-support/isolated-env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { createSessionToken, revokeSessionToken, SESSION_COOKIE_NAME } from "./auth";
import { sessionRefusal } from "./route-guard";
import { GET as listConfig } from "@/app/api/config/route";
import { POST as createUser } from "@/app/api/admin/user/create/route";

const BASE = "http://localhost:3000";

const request = (path: string, cookie?: string, init: RequestInit = {}) =>
  new NextRequest(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {}),
      origin: BASE,
      "content-type": "application/json",
    },
  });

describe("sessionRefusal", () => {
  it("refuses a request with no session, or a made-up one", async () => {
    for (const cookie of [undefined, "", "v2.9999999999.abc.e30.deadbeef", "garbage"]) {
      const refused = await sessionRefusal(request("/api/anything", cookie));
      assert.equal(refused?.status, 401, String(cookie));
    }
  });

  it("lets a signed-in request through", async () => {
    const token = await createSessionToken();
    assert.equal(await sessionRefusal(request("/api/anything", token)), null);
  });

  it("refuses a session that was signed out", async () => {
    const token = await createSessionToken();
    await revokeSessionToken(token);
    assert.equal((await sessionRefusal(request("/api/anything", token)))?.status, 401);
  });
});

describe("routes, called directly as if the gate had been skipped", () => {
  it("answer 401 and do nothing without a session", async () => {
    assert.equal((await listConfig(request("/api/config"))).status, 401);
    const res = await createUser(
      request("/api/admin/user/create", undefined, {
        method: "POST",
        body: JSON.stringify({
          givenName: "Eve",
          familyName: "Intruder",
          primaryEmail: "eve@example.com",
          confirm: "eve@example.com",
        }),
      })
    );
    assert.equal(res.status, 401);
  });

  it("still work with one", async () => {
    const token = await createSessionToken();
    assert.equal((await listConfig(request("/api/config", token))).status, 200);
  });
});
