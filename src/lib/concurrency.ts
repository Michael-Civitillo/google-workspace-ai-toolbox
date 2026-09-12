/**
 * Process-wide admission control for the routes that hold real memory while
 * they run (mailbox export and import pages, each tens to hundreds of MB at
 * their caps). Per-request work is already bounded; this bounds how many
 * such requests run at once, so two operators exporting large mailboxes
 * can't take a small host down together.
 *
 * Slots are counted on globalThis so every server bundle in the process
 * shares one table. A slot that is never released (a handler that threw
 * before its `finally`) is not a concern: callers release in `finally`.
 */
const SLOTS_KEY = "__openAdminBusySlots";

function table(): Map<string, number> {
  const g = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  if (!g[SLOTS_KEY]) g[SLOTS_KEY] = new Map();
  return g[SLOTS_KEY] as Map<string, number>;
}

export class BusyError extends Error {
  constructor(what: string) {
    super(`Another ${what} is already running on this server — try again in a moment.`);
    this.name = "BusyError";
  }
}

/**
 * Take a slot under `key`, or throw BusyError when `max` are already taken.
 * Returns the release function; call it in a `finally`.
 */
export function acquireSlot(key: string, max: number, what: string): () => void {
  const t = table();
  const busy = t.get(key) ?? 0;
  if (busy >= max) throw new BusyError(what);
  t.set(key, busy + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = t.get(key) ?? 1;
    if (now <= 1) t.delete(key);
    else t.set(key, now - 1);
  };
}
