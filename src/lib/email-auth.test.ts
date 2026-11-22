import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkDkim,
  checkDmarc,
  checkDomainEmailAuth,
  checkSpf,
  compareDomains,
  emailAuthIncomplete,
  emailAuthNeedsReview,
  worstVerdict,
  type TxtLookup,
} from "./email-auth";
import { configuredDnsServers } from "./dns-txt";

const GOOGLE_SPF = "v=spf1 include:_spf.google.com ~all";
const DKIM_KEY = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA";

describe("checkSpf", () => {
  it("accepts Google's recommended record", () => {
    const c = checkSpf([GOOGLE_SPF]);
    assert.equal(c.verdict, "ok");
    assert.equal(c.record, GOOGLE_SPF);
  });

  it("accepts a strict record", () => {
    assert.equal(checkSpf(["v=spf1 include:_spf.google.com -all"]).verdict, "ok");
  });

  it("ignores other TXT records at the domain", () => {
    assert.equal(
      checkSpf(["google-site-verification=abc", GOOGLE_SPF, "MS=ms123"]).verdict,
      "ok"
    );
  });

  it("flags a missing record", () => {
    assert.equal(checkSpf([]).verdict, "bad");
    assert.equal(checkSpf(["google-site-verification=abc"]).verdict, "bad");
  });

  it("flags more than one record, which receivers treat as none", () => {
    const c = checkSpf([GOOGLE_SPF, "v=spf1 ip4:203.0.113.5 -all"]);
    assert.equal(c.verdict, "bad");
    assert.match(c.summary, /2 SPF records/);
  });

  it("flags a record that lets anyone send", () => {
    assert.equal(checkSpf(["v=spf1 include:_spf.google.com +all"]).verdict, "bad");
    assert.equal(checkSpf(["v=spf1 all"]).verdict, "bad");
  });

  it("warns about a neutral or missing ending", () => {
    assert.equal(checkSpf(["v=spf1 include:_spf.google.com ?all"]).verdict, "warn");
    assert.equal(checkSpf(["v=spf1 include:_spf.google.com"]).verdict, "warn");
  });

  it("warns when Google's servers aren't listed", () => {
    const c = checkSpf(["v=spf1 ip4:203.0.113.5 -all"]);
    assert.equal(c.verdict, "warn");
    assert.match(c.summary, /_spf\.google\.com/);
  });

  it("accepts a domain that declares it sends no mail", () => {
    assert.equal(checkSpf(["v=spf1 -all"]).verdict, "ok");
  });

  it("does not second-guess a record that redirects elsewhere", () => {
    assert.equal(checkSpf(["v=spf1 redirect=_spf.example.net"]).verdict, "ok");
  });

  it("reads the record whatever its case", () => {
    assert.equal(checkSpf(["V=SPF1 INCLUDE:_SPF.GOOGLE.COM ~ALL"]).verdict, "ok");
  });
});

describe("checkDmarc", () => {
  it("accepts an enforcing policy", () => {
    assert.equal(checkDmarc(["v=DMARC1; p=reject; rua=mailto:d@example.com"]).verdict, "ok");
    assert.equal(checkDmarc(["v=DMARC1; p=quarantine"]).verdict, "ok");
  });

  it("warns that monitor-only still delivers spoofed mail", () => {
    const c = checkDmarc(["v=DMARC1; p=none; rua=mailto:d@example.com"]);
    assert.equal(c.verdict, "warn");
    assert.match(c.summary, /monitor only/);
  });

  it("warns when the policy covers only part of the mail", () => {
    const c = checkDmarc(["v=DMARC1; p=reject; pct=25"]);
    assert.equal(c.verdict, "warn");
    assert.match(c.summary, /25%/);
  });

  it("flags a missing, duplicated or policy-less record", () => {
    assert.equal(checkDmarc([]).verdict, "bad");
    assert.equal(checkDmarc(["v=DMARC1; p=none", "v=DMARC1; p=reject"]).verdict, "bad");
    assert.equal(checkDmarc(["v=DMARC1; rua=mailto:d@example.com"]).verdict, "bad");
  });

  it("uses the parent's subdomain policy when the record is inherited", () => {
    const inherited = checkDmarc(["v=DMARC1; p=reject; sp=none"], "example.com");
    assert.equal(inherited.verdict, "warn", "sp=none governs subdomains");
    assert.match(inherited.summary, /inherited from example\.com/);
    assert.equal(checkDmarc(["v=DMARC1; p=reject; sp=none"]).verdict, "ok", "but not the domain itself");
  });
});

describe("checkDkim", () => {
  it("accepts a published key", () => {
    assert.equal(checkDkim([DKIM_KEY], "google").verdict, "ok");
  });

  it("says it cannot tell when nothing is at the default selector", () => {
    const c = checkDkim([], "google");
    assert.equal(c.verdict, "unknown");
    assert.match(c.summary, /different selector/);
  });

  it("flags a revoked key", () => {
    assert.equal(checkDkim(["v=DKIM1; k=rsa; p="], "google").verdict, "bad");
  });

  it("accepts a key published without the optional version tag", () => {
    assert.equal(checkDkim(["k=rsa; p=MIIBIjANBgkq"], "google").verdict, "ok");
  });
});

/** A resolver answering from a table; a name that maps to an Error fails. */
function dns(table: Record<string, string[] | Error>): { lookup: TxtLookup; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    lookup: async (name) => {
      asked.push(name);
      const answer = table[name];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
  };
}

describe("checkDomainEmailAuth", () => {
  const domain = { domainName: "Example.com", isPrimary: true };

  it("looks in the three right places and reports a healthy domain", async () => {
    const { lookup, asked } = dns({
      "example.com": [GOOGLE_SPF],
      "google._domainkey.example.com": [DKIM_KEY],
      "_dmarc.example.com": ["v=DMARC1; p=reject"],
    });
    const result = await checkDomainEmailAuth(domain, lookup);
    assert.deepEqual(asked.sort(), [
      "_dmarc.example.com",
      "example.com",
      "google._domainkey.example.com",
    ]);
    assert.equal(result.domain, "example.com");
    assert.equal(result.primary, true);
    assert.deepEqual([result.spf.verdict, result.dkim.verdict, result.dmarc.verdict], ["ok", "ok", "ok"]);
    assert.equal(emailAuthNeedsReview(result), false);
    assert.equal(emailAuthIncomplete(result), false);
  });

  it("reports a domain with nothing published", async () => {
    const result = await checkDomainEmailAuth(domain, dns({}).lookup);
    assert.deepEqual(
      [result.spf.verdict, result.dkim.verdict, result.dmarc.verdict],
      ["bad", "unknown", "bad"]
    );
    assert.equal(worstVerdict(result), "bad");
    assert.equal(emailAuthNeedsReview(result), true);
  });

  it("lets a subdomain inherit its parent's DMARC policy", async () => {
    const { lookup, asked } = dns({
      "mail.example.com": [GOOGLE_SPF],
      "_dmarc.example.com": ["v=DMARC1; p=quarantine"],
    });
    const result = await checkDomainEmailAuth(
      { domainName: "mail.example.com", isPrimary: false },
      lookup
    );
    assert.equal(result.dmarc.verdict, "ok");
    assert.match(result.dmarc.summary, /inherited from example\.com/);
    assert.ok(asked.includes("_dmarc.mail.example.com"), "its own record is tried first");
  });

  it("inherits only from the organizational domain, never from a public suffix", async () => {
    const { lookup, asked } = dns({
      "_dmarc.gov.uk": ["v=DMARC1; p=reject"],
      "_dmarc.b.example.com": ["v=DMARC1; p=none"],
      "_dmarc.example.com": ["v=DMARC1; p=quarantine"],
    });
    const council = await checkDomainEmailAuth({ domainName: "council.gov.uk", isPrimary: true }, lookup);
    assert.notEqual(council.dmarc.verdict, "ok", "gov.uk's own record covers nobody else");
    assert.ok(!asked.includes("_dmarc.gov.uk"));
    const deep = await checkDomainEmailAuth({ domainName: "a.b.example.com", isPrimary: false }, lookup);
    assert.match(deep.dmarc.summary, /inherited from example\.com/);
    assert.ok(!asked.includes("_dmarc.b.example.com"), "not an intermediate parent");
    const ukSub = await checkDomainEmailAuth({ domainName: "mail.shop.co.uk", isPrimary: false }, dns({ "_dmarc.shop.co.uk": ["v=DMARC1; p=reject"] }).lookup);
    assert.match(ukSub.dmarc.summary, /inherited from shop\.co\.uk/);
  });

  it("reports a failed lookup as unknown, never as a missing record", async () => {
    const { lookup } = dns({
      "example.com": new Error("the DNS server did not answer in time"),
      "google._domainkey.example.com": [DKIM_KEY],
      "_dmarc.example.com": new Error("DNS lookup failed (ESERVFAIL)"),
    });
    const result = await checkDomainEmailAuth(domain, lookup);
    assert.equal(result.spf.verdict, "error");
    assert.match(result.spf.summary, /did not answer in time/);
    assert.equal(result.dkim.verdict, "ok", "one failed lookup doesn't spoil the others");
    assert.equal(result.dmarc.verdict, "error");
    assert.equal(emailAuthIncomplete(result), true);
    assert.equal(emailAuthNeedsReview(result), false, "nothing was found wrong");
  });
});

describe("compareDomains", () => {
  const check = (verdict: "ok" | "warn" | "bad") => ({ verdict, summary: "", record: null });
  const d = (domain: string, primary: boolean, worst: "ok" | "warn" | "bad") => ({
    domain,
    primary,
    spf: check(worst),
    dkim: check("ok"),
    dmarc: check("ok"),
  });

  it("puts the worst first, then the primary domain, then by name", () => {
    const sorted = [
      d("b-fine.example", false, "ok"),
      d("primary.example", true, "ok"),
      d("z-broken.example", false, "bad"),
      d("a-weak.example", false, "warn"),
    ].sort(compareDomains);
    assert.deepEqual(
      sorted.map((x) => x.domain),
      ["z-broken.example", "a-weak.example", "primary.example", "b-fine.example"]
    );
  });
});

describe("configuredDnsServers", () => {
  it("is empty by default, meaning the machine's own resolver", () => {
    assert.deepEqual(configuredDnsServers({}), []);
    assert.deepEqual(configuredDnsServers({ OPEN_ADMIN_DNS_SERVERS: "  " }), []);
  });

  it("reads a comma-separated list", () => {
    assert.deepEqual(
      configuredDnsServers({ OPEN_ADMIN_DNS_SERVERS: " 8.8.8.8 , 1.1.1.1:53,, " }),
      ["8.8.8.8", "1.1.1.1:53"]
    );
  });
});
