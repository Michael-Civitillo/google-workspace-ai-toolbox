import { createHash, randomBytes } from "node:crypto";

/**
 * One-time sign-in tickets for the packaged desktop build.
 *
 * The desktop launcher starts the server and opens the browser. It already
 * holds the sign-in password (it chose or generated it), so asking the person
 * to type that password into the page it just opened protects nothing; it is
 * only something to forget. Instead the launcher trades the password for a
 * ticket and opens the browser on a URL that carries it, and the ticket is
 * exchanged for an ordinary session.
 *
 * A ticket is random, usable once, and dead after a minute, so the URL is
 * worthless in the browser's history. Only the packaged build offers this at
 * all: a server run from source, in Docker or behind a proxy answers 404.
 *
 * Tickets live in memory on globalThis so the two route bundles that issue
 * and redeem them share one table, and are stored as hashes: nothing in the
 * process holds a redeemable value after it has been handed out.
 */

export const LAUNCH_TICKET_TTL_MS = 60_000;
/** A launcher needs one at a time; this bounds what a caller can pile up. */
const MAX_OUTSTANDING = 8;

const STORE_KEY = "__openAdminLaunchTickets";

function store(): Map<string, number> {
  const g = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  if (!g[STORE_KEY]) g[STORE_KEY] = new Map();
  return g[STORE_KEY] as Map<string, number>;
}

const hash = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

function dropExpired(map: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of map) {
    if (expiresAt <= now) map.delete(key);
  }
}

/** Whether this server offers ticket sign-in at all. */
export function launchTicketsSupported(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.OPEN_ADMIN_PACKAGED === "1";
}

/** Mint a ticket. The caller has already proved it knows the password. */
export function issueLaunchTicket(now: number = Date.now()): string {
  const map = store();
  dropExpired(map, now);
  // Oldest first: a Map iterates in insertion order.
  while (map.size >= MAX_OUTSTANDING) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  const ticket = randomBytes(32).toString("base64url");
  map.set(hash(ticket), now + LAUNCH_TICKET_TTL_MS);
  return ticket;
}

/**
 * Redeem a ticket. True exactly once per ticket, and only before it expires;
 * it is spent whether or not it was still valid.
 */
export function redeemLaunchTicket(
  ticket: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!ticket || ticket.length > 128) return false;
  const map = store();
  const key = hash(ticket);
  const expiresAt = map.get(key);
  if (expiresAt === undefined) return false;
  map.delete(key);
  return expiresAt > now;
}

/** For tests: forget every outstanding ticket. */
export function clearLaunchTickets(): void {
  store().clear();
}
