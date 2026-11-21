import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  clearLaunchTickets,
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
