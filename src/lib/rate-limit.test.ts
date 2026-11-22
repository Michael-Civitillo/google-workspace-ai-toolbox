/**
 * The in-process rate limiter.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { clearRateLimit, rateLimit, reserveAttempt, resetRateLimits } from "./rate-limit";

const MINUTE = 60_000;

beforeEach(() => {
  resetRateLimits();
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
});
afterEach(() => mock.timers.reset());

describe("rateLimit", () => {
  it("allows up to the limit in a window, then refuses with a wait", () => {
    for (let i = 0; i < 5; i++) assert.equal(rateLimit("k", 5, 15 * MINUTE).allowed, true);
    const refused = rateLimit("k", 5, 15 * MINUTE);
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfter, 15 * 60);
  });

  it("allows again once the window has passed", () => {
    for (let i = 0; i < 5; i++) rateLimit("k", 5, 15 * MINUTE);
    mock.timers.tick(15 * MINUTE + 1);
    assert.equal(rateLimit("k", 5, 15 * MINUTE).allowed, true);
  });

  it("ages each key by its own window, so a short-window caller can't reset a long one", () => {
    for (let i = 0; i < 5; i++) rateLimit("login:anon", 5, 15 * MINUTE);
    mock.timers.tick(MINUTE + 1);
    // An unrelated check with a one-minute window sweeps the table.
    rateLimit("sso-discover:anon", 10, MINUTE);
    assert.equal(rateLimit("login:anon", 5, 15 * MINUTE).allowed, false);
  });

  it("forgets a key when cleared", () => {
    for (let i = 0; i < 5; i++) rateLimit("k", 5, MINUTE);
    clearRateLimit("k");
    assert.equal(rateLimit("k", 5, MINUTE).allowed, true);
  });
});

describe("reserveAttempt", () => {
  it("counts the attempt at once, so a burst can't all pass before any is counted", () => {
    const results = Array.from({ length: 100 }, () => reserveAttempt("login:anon", 5, 15 * MINUTE));
    assert.equal(results.filter((r) => r.allowed).length, 5);
  });
});
