import http from "node:http";

/**
 * Opening the browser already signed in.
 *
 * The launcher holds the sign-in password (it chose or generated it). Rather
 * than have the person type it into the page the launcher just opened, the
 * launcher trades it for a one-time ticket and opens the browser on a URL that
 * carries the ticket. The server side is src/lib/launch-tickets.ts.
 *
 * Everything here fails soft: if a ticket can't be had for any reason, the
 * browser opens on the ordinary sign-in page and the password still works.
 */

/** Ask the running server for a one-time sign-in ticket. Null on any failure. */
export function requestLaunchTicket(
  host: string,
  port: number,
  password: string,
  origin: string,
  timeoutMs = 5000
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!password) {
      resolve(null);
      return;
    }
    const body = JSON.stringify({ password });
    const req = http.request(
      {
        host,
        port,
        path: "/api/auth/launch-ticket",
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          // The app's same-origin check on mutating requests applies to the
          // launcher too; this is the origin the browser will use.
          origin,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (text.length < 8192) text += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const ticket = (JSON.parse(text) as { ticket?: unknown }).ticket;
            resolve(typeof ticket === "string" && ticket ? ticket : null);
          } catch {
            resolve(null);
          }
        });
        res.on("error", () => resolve(null));
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end(body);
  });
}

/** Where to point the browser: the ticket URL, or the plain app when there is none. */
export function signInUrl(baseUrl: string, ticket: string | null): string {
  return ticket
    ? `${baseUrl}/api/auth/launch?ticket=${encodeURIComponent(ticket)}`
    : baseUrl;
}

/** Automatic sign-in is for this machine only. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
