/**
 * Email authentication: does each of the tenant's domains publish the three
 * DNS records that stop other people sending mail in its name?
 *
 *   SPF    which servers may send mail for the domain
 *   DKIM   a public key receivers use to check a message's signature
 *   DMARC  what receivers should do with mail that fails those checks
 *
 * No Google API is involved and no permission is needed: these are public DNS
 * records. This module holds the rules and takes the DNS lookup as a
 * parameter, so it has no Node imports, the page can share its types, and the
 * tests can hand it canned answers.
 */

export type Verdict = "ok" | "warn" | "bad" | "unknown" | "error";

export interface RecordCheck {
  verdict: Verdict;
  /** One plain sentence: what was found and why it matters. */
  summary: string;
  /** The record as published, when there is exactly one. */
  record: string | null;
}

export interface DomainEmailAuth {
  domain: string;
  primary: boolean;
  spf: RecordCheck;
  dkim: RecordCheck;
  dmarc: RecordCheck;
}

/**
 * Looks up TXT records. Resolves with each record as one string (DNS splits
 * long records into chunks; the caller joins them), or with [] when the name
 * has none. Rejects only when the lookup itself failed.
 */
export type TxtLookup = (name: string) => Promise<string[]>;

/** The DKIM selector Google Workspace generates keys under by default. */
export const GOOGLE_DKIM_SELECTOR = "google";

const hasTag = (record: string, tag: string) =>
  record.trim().toLowerCase().startsWith(tag);

/** `key=value` pairs of a DMARC or DKIM record. */
function tags(record: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  return out;
}

export function checkSpf(records: readonly string[]): RecordCheck {
  const spf = records.filter((r) => hasTag(r, "v=spf1"));
  if (spf.length === 0) {
    return {
      verdict: "bad",
      summary:
        "No SPF record. Nothing tells other mail systems which servers may send for this domain.",
      record: null,
    };
  }
  if (spf.length > 1) {
    return {
      verdict: "bad",
      summary: `${spf.length} SPF records. A domain may have only one; receivers treat more as an error and ignore them all.`,
      record: null,
    };
  }
  const record = spf[0].trim();
  const terms = record.toLowerCase().split(/\s+/).slice(1);
  const all = terms.find((t) => /^[+\-~?]?all$/.test(t));
  const redirects = terms.some((t) => t.startsWith("redirect="));
  const mechanisms = terms.filter(
    (t) => !/^[+\-~?]?all$/.test(t) && !t.startsWith("redirect=") && !t.includes("=")
  );

  if (all === "+all" || all === "all") {
    return {
      verdict: "bad",
      summary: 'Ends in "+all", which allows any server in the world to send as this domain.',
      record,
    };
  }
  // "v=spf1 -all" with nothing else is a deliberate "this domain sends no mail".
  if (all === "-all" && mechanisms.length === 0) {
    return {
      verdict: "ok",
      summary: "Says this domain sends no mail at all, which is the right record for one that doesn't.",
      record,
    };
  }
  if (!all && !redirects) {
    return {
      verdict: "warn",
      summary: 'Doesn\'t end in "~all" or "-all", so it never says what to do with mail from other servers.',
      record,
    };
  }
  if (all === "?all") {
    return {
      verdict: "warn",
      summary: 'Ends in "?all" (neutral): mail from servers that aren\'t listed is treated as if there were no record.',
      record,
    };
  }
  if (!redirects && !terms.some((t) => t.includes("_spf.google.com"))) {
    return {
      verdict: "warn",
      summary:
        "Google's mail servers aren't listed (include:_spf.google.com), so mail sent from Gmail can fail this check.",
      record,
    };
  }
  return {
    verdict: "ok",
    summary:
      all === "-all"
        ? "Published, and rejects mail from servers that aren't listed."
        : "Published, and marks mail from servers that aren't listed as suspect.",
    record,
  };
}

export function checkDmarc(records: readonly string[], inheritedFrom?: string): RecordCheck {
  const dmarc = records.filter((r) => hasTag(r, "v=dmarc1"));
  if (dmarc.length === 0) {
    return {
      verdict: "bad",
      summary:
        "No DMARC policy. Receivers aren't told what to do with mail that fails SPF and DKIM, and you get no reports of who is sending as you.",
      record: null,
    };
  }
  if (dmarc.length > 1) {
    return {
      verdict: "bad",
      summary: `${dmarc.length} DMARC records. Only one is allowed; receivers ignore them all.`,
      record: null,
    };
  }
  const record = dmarc[0].trim();
  const t = tags(record);
  // A subdomain follows the parent's `sp` when it has one.
  const policy = ((inheritedFrom && t.get("sp")) || t.get("p") || "").toLowerCase();
  const from = inheritedFrom ? ` (inherited from ${inheritedFrom})` : "";
  if (policy === "reject" || policy === "quarantine") {
    const pct = Number(t.get("pct") ?? "100");
    const partial = Number.isFinite(pct) && pct < 100;
    return {
      verdict: partial ? "warn" : "ok",
      summary:
        (policy === "reject"
          ? "Tells receivers to reject mail that fails the checks"
          : "Tells receivers to send mail that fails the checks to spam") +
        from +
        (partial ? `, but only for ${pct}% of it.` : "."),
      record,
    };
  }
  if (policy === "none") {
    return {
      verdict: "warn",
      summary: `Set to monitor only (p=none)${from}: you get reports, but spoofed mail is still delivered.`,
      record,
    };
  }
  return {
    verdict: "bad",
    summary: `Has no valid policy (p=)${from}, so receivers ignore it.`,
    record,
  };
}

export function checkDkim(records: readonly string[], selector: string): RecordCheck {
  const keys = records.filter((r) => hasTag(r, "v=dkim1") || /(^|;)\s*p=/i.test(r));
  if (keys.length === 0) {
    return {
      verdict: "unknown",
      summary: `No key at Google's default selector ("${selector}"). Either DKIM signing isn't turned on, or it uses a different selector, which can't be discovered from outside.`,
      record: null,
    };
  }
  const record = keys[0].trim();
  const key = (tags(record).get("p") ?? "").replace(/\s+/g, "");
  if (!key) {
    return {
      verdict: "bad",
      summary: "The key has been revoked (empty p=), so every signed message fails the check.",
      record,
    };
  }
  return {
    verdict: "ok",
    summary: "A signing key is published, so receivers can check that mail really came from you.",
    record,
  };
}

/** Parent domains to try for an inherited DMARC policy, nearest first. */
function parents(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 1; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

const lookupFailed = (what: string, e: unknown): RecordCheck => ({
  verdict: "error",
  summary: `${what} could not be looked up: ${
    (e instanceof Error ? e.message : String(e)).slice(0, 160)
  }`,
  record: null,
});

/**
 * Check one domain. A lookup that fails is reported against that record and
 * never guessed at: "we could not ask" is not "it is missing".
 */
export async function checkDomainEmailAuth(
  domain: { domainName: string; isPrimary: boolean },
  lookup: TxtLookup
): Promise<DomainEmailAuth> {
  const name = domain.domainName.toLowerCase();

  const spf = lookup(name).then(checkSpf, (e) => lookupFailed("SPF", e));

  const dkim = lookup(`${GOOGLE_DKIM_SELECTOR}._domainkey.${name}`).then(
    (records) => checkDkim(records, GOOGLE_DKIM_SELECTOR),
    (e) => lookupFailed("DKIM", e)
  );

  const dmarc = (async (): Promise<RecordCheck> => {
    try {
      const own = await lookup(`_dmarc.${name}`);
      if (own.some((r) => hasTag(r, "v=dmarc1"))) return checkDmarc(own);
      // A subdomain without its own record follows its parent's.
      for (const parent of parents(name)) {
        const inherited = await lookup(`_dmarc.${parent}`);
        if (inherited.some((r) => hasTag(r, "v=dmarc1"))) {
          return checkDmarc(inherited, parent);
        }
      }
      return checkDmarc([]);
    } catch (e) {
      return lookupFailed("DMARC", e);
    }
  })();

  return {
    domain: name,
    primary: domain.isPrimary,
    spf: await spf,
    dkim: await dkim,
    dmarc: await dmarc,
  };
}

const RANK: Record<Verdict, number> = { bad: 3, warn: 2, unknown: 2, error: 1, ok: 0 };

/** The worst of a domain's three verdicts. */
export function worstVerdict(d: DomainEmailAuth): Verdict {
  return [d.spf, d.dkim, d.dmarc]
    .map((c) => c.verdict)
    .sort((a, b) => RANK[b] - RANK[a])[0];
}

/** Does this domain have something to fix or look into? */
export function emailAuthNeedsReview(d: DomainEmailAuth): boolean {
  return [d.spf, d.dkim, d.dmarc].some(
    (c) => c.verdict === "bad" || c.verdict === "warn" || c.verdict === "unknown"
  );
}

/** Were any of this domain's lookups impossible to make? */
export function emailAuthIncomplete(d: DomainEmailAuth): boolean {
  return [d.spf, d.dkim, d.dmarc].some((c) => c.verdict === "error");
}

/** Worst first, then the primary domain, then by name. */
export function compareDomains(a: DomainEmailAuth, b: DomainEmailAuth): number {
  return (
    RANK[worstVerdict(b)] - RANK[worstVerdict(a)] ||
    Number(b.primary) - Number(a.primary) ||
    a.domain.localeCompare(b.domain)
  );
}

export interface EmailAuthReport {
  domains: DomainEmailAuth[];
}
