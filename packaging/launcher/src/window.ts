/**
 * Keeping the console window on screen when a start fails.
 *
 * Double-clicking the executable on Windows gives it a console window of its
 * own, and that window disappears the instant the process exits. A start that
 * fails would therefore flash a message nobody can read and leave the person
 * looking at an empty desktop. So when the launch looks like a double-click,
 * the launcher waits for a key before it exits with an error.
 */

export interface HoldInputs {
  platform: NodeJS.Platform;
  /** Running as the packaged single-file executable. */
  packaged: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  /** Number of command-line arguments the user passed. */
  userArgCount: number;
  exitCode: number;
}

/**
 * Whether to wait for a key before exiting.
 *
 * There is no dependable way, from inside Node, to ask Windows whether the
 * console belongs to this process alone. What a double-click never does is
 * pass arguments, so "no arguments, on an interactive console" stands in for
 * it. The cost of the heuristic being wrong is small either way: someone who
 * ran the bare executable from a terminal presses a key once after an error,
 * and anything scripted either passes arguments or has no terminal attached.
 * macOS and Linux terminals stay open on their own.
 */
export function shouldHoldWindow(inputs: HoldInputs): boolean {
  return (
    inputs.exitCode !== 0 &&
    inputs.platform === "win32" &&
    inputs.packaged &&
    inputs.stdinIsTTY &&
    inputs.stdoutIsTTY &&
    inputs.userArgCount === 0
  );
}

/**
 * Resolve on the next key press. Resolves at once when there is no terminal to
 * read from, and never rejects: this runs on the way out of a failed start,
 * where a second error would only hide the first.
 */
export function waitForKey(input: NodeJS.ReadStream = process.stdin): Promise<void> {
  return new Promise((resolve) => {
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      resolve();
      return;
    }
    const wasRaw = input.isRaw;
    const done = (): void => {
      try {
        input.setRawMode(Boolean(wasRaw));
        input.pause();
      } catch {
        // The console is going away; nothing left to restore.
      }
      resolve();
    };
    try {
      input.setRawMode(true);
      input.resume();
      input.once("data", done);
      input.once("error", done);
      input.once("end", done);
    } catch {
      done();
    }
  });
}
