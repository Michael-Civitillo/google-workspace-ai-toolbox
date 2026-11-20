import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { shouldHoldWindow, waitForKey, type HoldInputs } from "../src/window.ts";

/** A failed start from a double-click on Windows: the one case that holds. */
const DOUBLE_CLICK_FAILURE: HoldInputs = {
  platform: "win32",
  packaged: true,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  userArgCount: 0,
  exitCode: 3,
};

describe("shouldHoldWindow", () => {
  it("holds the window when a double-clicked start fails on Windows", () => {
    assert.equal(shouldHoldWindow(DOUBLE_CLICK_FAILURE), true);
  });

  it("does not hold on a clean exit", () => {
    assert.equal(shouldHoldWindow({ ...DOUBLE_CLICK_FAILURE, exitCode: 0 }), false);
  });

  it("does not hold when arguments were passed (a terminal or a script)", () => {
    assert.equal(shouldHoldWindow({ ...DOUBLE_CLICK_FAILURE, userArgCount: 1 }), false);
  });

  it("does not hold without an interactive console on both ends", () => {
    assert.equal(shouldHoldWindow({ ...DOUBLE_CLICK_FAILURE, stdinIsTTY: false }), false);
    assert.equal(shouldHoldWindow({ ...DOUBLE_CLICK_FAILURE, stdoutIsTTY: false }), false);
  });

  it("does not hold on macOS or Linux, where the terminal stays open", () => {
    assert.equal(shouldHoldWindow({ ...DOUBLE_CLICK_FAILURE, platform: "darwin" }), false);
    assert.equal(shouldHoldWindow({ ...DOUBLE_CLICK_FAILURE, platform: "linux" }), false);
  });

  it("does not hold when run as a plain script during development", () => {
    assert.equal(shouldHoldWindow({ ...DOUBLE_CLICK_FAILURE, packaged: false }), false);
  });
});

/** Just enough of a TTY input stream to drive waitForKey. */
class FakeTty extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  rawCalls: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawCalls.push(mode);
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
}

describe("waitForKey", () => {
  it("waits for a key, then puts the terminal back as it found it", async () => {
    const tty = new FakeTty();
    let settled = false;
    const waiting = waitForKey(tty as unknown as NodeJS.ReadStream).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(tty.isRaw, true);
    assert.equal(tty.paused, false);

    tty.emit("data", "x");
    await waiting;
    assert.deepEqual(tty.rawCalls, [true, false]);
    assert.equal(tty.paused, true);
  });

  it("returns at once when there is no terminal", async () => {
    const piped = Object.assign(new EventEmitter(), { isTTY: false });
    await waitForKey(piped as unknown as NodeJS.ReadStream);
  });

  it("returns instead of throwing when raw mode is refused", async () => {
    const tty = new FakeTty();
    tty.setRawMode = () => {
      throw new Error("console is gone");
    };
    await waitForKey(tty as unknown as NodeJS.ReadStream);
  });
});
