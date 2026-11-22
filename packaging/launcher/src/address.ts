import { isLoopbackHost } from "./signin.ts";

/**
 * The address the server binds, the address the launcher talks to it on, and
 * the address the browser is sent to are not always the same.
 *
 * Bound to every address (`--host 0.0.0.0`, or `::`), the server cannot be
 * reached at the bind address itself: Windows refuses a connection to 0.0.0.0
 * outright (EADDRNOTAVAIL), so the launcher used to spend its whole 60-second
 * wait failing to connect and then stop a server that was working fine. It is
 * reached on loopback instead, and the browser is sent to localhost.
 */

/** "[::1]" as typed on a command line, or "::1": the address itself. */
export function normalizeHost(host: string): string {
  const trimmed = host.trim();
  return trimmed.length > 2 && trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** True for an "every address" bind. */
export function isUnspecifiedHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0";
}

/** Where this machine reaches a server bound to `host`. */
export function reachableHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (isUnspecifiedHost(host)) return "::1";
  return host;
}

/** A host as it is written in a URL: an IPv6 address goes in brackets. */
export function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * The address to show and open for a server bound to `host`.
 *
 * A loopback URL must be spelled `localhost`, not `127.0.0.1`. The standalone
 * Next.js server treats the address it bound as the canonical host and
 * normalises every loopback spelling to `localhost`; the app's CSRF check
 * compares the browser's Origin against that. The app now also accepts the
 * numeric form, but `localhost` is additionally what browsers treat as a
 * trustworthy origin, which is what lets the Secure session cookie work over
 * plain HTTP. So: bind the address, advertise the name. A server bound to
 * every address is opened the same way on this machine; nobody can browse to
 * http://0.0.0.0:<port>.
 */
export function browsableUrl(host: string, port: number): string {
  const shown = isLoopbackHost(host) || isUnspecifiedHost(host) ? "localhost" : urlHost(host);
  return `http://${shown}:${port}`;
}
