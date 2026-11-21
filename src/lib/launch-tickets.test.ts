import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import {
  clearLaunchTickets,
  INSTANCE_PROOF_LABEL,
  instanceProof,
  issueLaunchTicket,
  LAUNCH_TICKET_TTL_MS,
  launchTicketsSupported,
  redeemLaunchTicket,
} from "./launch-tickets";

beforeEach(() => clearLaunchTickets());

describe("launch tickets", () => {
  it("are offered by the packaged build only", () => {
    assert.equal(launchTicketsSupported({ OPEN_ADMIN_PACKAGED: "1" }), true);
    assert.equal(launchTicketsSupported({}), false);
    assert.equal(launchTicketsSupported({ OPEN_ADMIN_PACKAGED: "true" }), false);
  });

  it("can be redeemed once", () => {
    const ticket = issueLaunchTicket();
    assert.equal(redeemLaunchTicket(ticket), true);
    assert.equal(redeemLaunchTicket(ticket), false, "a second use is refused");
  });

  it("are long, unguessable and different every time", () => {
    const a = issueLaunchTicket();
    const b = issueLaunchTicket();
    assert.notEqual(a, b);
    assert.ok(a.length >= 43, "32 random bytes");
    assert.match(a, /^[A-Za-z0-9_-]+$/, "safe to put in a URL as it is");
  });

  it("expire after a minute", () => {
    const t0 = 1_000_000;
    const fresh = issueLaunchTicket(t0);
    assert.equal(redeemLaunchTicket(fresh, t0 + LAUNCH_TICKET_TTL_MS - 1), true);
    const stale = issueLaunchTicket(t0);
    assert.equal(redeemLaunchTicket(stale, t0 + LAUNCH_TICKET_TTL_MS), false);
    assert.equal(redeemLaunchTicket(stale, t0), false, "and an expired ticket is spent");
  });

  it("refuse anything that was never issued", () => {
    issueLaunchTicket();
    for (const bad of [null, undefined, "", "guess", "x".repeat(129)]) {
      assert.equal(redeemLaunchTicket(bad), false);
    }
  });

  it("keep only a handful outstanding, dropping the oldest", () => {
    const first = issueLaunchTicket();
    const rest = Array.from({ length: 8 }, () => issueLaunchTicket());
    assert.equal(redeemLaunchTicket(first), false, "pushed out by newer tickets");
    assert.equal(redeemLaunchTicket(rest[rest.length - 1]), true);
  });
});

describe("instanceProof", () => {
  const token = "a".repeat(64);
  const env = { OPEN_ADMIN_PACKAGED: "1", OPEN_ADMIN_INSTANCE_TOKEN: token };
  const challenge = "0123456789abcdef".repeat(4);

  it("answers HMAC-SHA256 of the labelled challenge, keyed by the instance token", () => {
    const want = createHmac("sha256", token)
      .update(INSTANCE_PROOF_LABEL + challenge)
      .digest("hex");
    assert.equal(instanceProof(challenge, env), want);
  });

  it("differs for another token, so a program that doesn't know it can't answer", () => {
    assert.notEqual(
      instanceProof(challenge, { ...env, OPEN_ADMIN_INSTANCE_TOKEN: "b".repeat(64) }),
      instanceProof(challenge, env)
    );
  });

  it("refuses when not started by the launcher, with no token, or a short one", () => {
    assert.equal(instanceProof(challenge, { OPEN_ADMIN_INSTANCE_TOKEN: token }), null);
    assert.equal(instanceProof(challenge, { OPEN_ADMIN_PACKAGED: "1" }), null);
    assert.equal(instanceProof(challenge, { ...env, OPEN_ADMIN_INSTANCE_TOKEN: "short" }), null);
  });

  it("refuses a challenge that isn't 64 lower-case hex characters", () => {
    for (const bad of ["", "abc", challenge.toUpperCase(), challenge + "0", challenge.slice(1) + "g"]) {
      assert.equal(instanceProof(bad, env), null, bad);
    }
  });
});
