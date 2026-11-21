/**
 * Sessions and sign-out.
 */
import "./test-support/isolated-env";
import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import {
  clearRevokedSessions,
  createSessionToken,
  readSessionIdentity,
  revokeSessionToken,
  verifySessionToken,
} from "./auth";

beforeEach(() => clearRevokedSessions());

/** A well-formed session token that this server never issued. */
function forgedToken(): string {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v2.9999999999.${nonce}.eyJtIjoicGFzc3dvcmQifQ.${"ab".repeat(32)}`;
}

describe("session tokens", () => {
  it("verify, and carry the identity they were issued with", async () => {
    const token = await createSessionToken({ method: "oidc", email: "jane@example.com" });
    assert.equal(await verifySessionToken(token), true);
    assert.deepEqual(await readSessionIdentity(token), { method: "oidc", email: "jane@example.com" });
  });

  it("refuse a token with a forged signature or a changed expiry", async () => {
    const token = await createSessionToken();
    const parts = token.split(".");
    assert.equal(await verifySessionToken(forgedToken()), false);
    assert.equal(await verifySessionToken([...parts.slice(0, 4), "0".repeat(64)].join(".")), false);
    assert.equal(await verifySessionToken(["v2", "9999999999", ...parts.slice(2)].join(".")), false);
  });
});

describe("signing out", () => {
  it("stops the signed-out token working", async () => {
    const token = await createSessionToken();
    await revokeSessionToken(token);
    assert.equal(await verifySessionToken(token), false);
  });

  it("leaves other sessions alone", async () => {
    const a = await createSessionToken();
    const b = await createSessionToken();
    await revokeSessionToken(a);
    assert.equal(await verifySessionToken(b), true);
  });

  it("can't be undone by a flood of sign-outs carrying made-up cookies", async () => {
    const token = await createSessionToken();
    await revokeSessionToken(token);
    for (let i = 0; i < 10_050; i++) await revokeSessionToken(forgedToken());
    assert.equal(await verifySessionToken(token), false);
  });

  it("stays in force for every genuine sign-out, however many there are", async () => {
    const tokens = await Promise.all(Array.from({ length: 300 }, () => createSessionToken()));
    for (const t of tokens) await revokeSessionToken(t);
    for (const t of tokens) assert.equal(await verifySessionToken(t), false);
  });

  it("ignores junk without throwing", async () => {
    for (const junk of [undefined, null, "", "x", "v2.1.2.3", "v2.a.b.c.d", forgedToken()]) {
      await revokeSessionToken(junk);
    }
  });

  it("forgets a sign-out once the token has expired anyway", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      const token = await createSessionToken();
      await revokeSessionToken(token);
      mock.timers.tick(13 * 60 * 60 * 1000);
      // Expired: refused for that reason, and the next sign-out prunes it.
      assert.equal(await verifySessionToken(token), false);
      await revokeSessionToken(await createSessionToken());
    } finally {
      mock.timers.reset();
    }
  });
});
