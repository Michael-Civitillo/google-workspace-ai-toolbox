import { Resolver } from "node:dns/promises";
import type { TxtLookup } from "./email-auth";

/**
 * TXT lookups for the email authentication check.
 *
 * Uses the machine's own DNS servers unless OPEN_ADMIN_DNS_SERVERS names
 * others (comma-separated addresses, optionally with a port). That is for
 * networks where the internal resolver answers differently from the public
 * one: what matters for these records is what the rest of the internet sees.
 */

const TIMEOUT_MS = 4000;

/** "This name has no such record" as opposed to "the lookup failed". */
const NO_RECORD = new Set(["ENODATA", "ENOTFOUND", "ENONAME", "NXDOMAIN"]);

export function configuredDnsServers(env: Record<string, string | undefined> = process.env): string[] {
  return (env.OPEN_ADMIN_DNS_SERVERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function makeTxtLookup(env: Record<string, string | undefined> = process.env): TxtLookup {
  const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 2 });
  const servers = configuredDnsServers(env);
  if (servers.length > 0) {
    try {
      resolver.setServers(servers);
    } catch (e) {
      // A typo here should not take the whole check down: say so and carry on
      // with the system resolver.
      console.warn(
        "[dns] ignoring OPEN_ADMIN_DNS_SERVERS:",
        e instanceof Error ? e.message : e
      );
    }
  }
  return async (name: string) => {
    try {
      const records = await resolver.resolveTxt(name);
      // DNS splits a long record into chunks; they are one string.
      return records.map((chunks) => chunks.join(""));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (NO_RECORD.has(code)) return [];
      throw new Error(
        code === "ETIMEOUT" || code === "ETIMEDOUT"
          ? "the DNS server did not answer in time"
          : `DNS lookup failed (${code || "unknown error"})`
      );
    }
  };
}
