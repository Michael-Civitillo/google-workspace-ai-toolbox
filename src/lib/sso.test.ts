/**
 * Single sign-on rules: whose identity is trusted, who may sign in, and what
 * the server refuses to save.
 */
import { TEST_DATA_DIR } from "./test-support/isolated-env";
import assert from "node:assert/strict";
import fs from "node:fs";
import dnsPromises from "node:dns/promises";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type * as client from "openid-client";
import { checkIssuer, evaluateSsoAccess, extractIdentity, loadOidcClient, OidcFlowError } from "./oidc";
import { consumeHandshake } from "./oidc-handshake";
import {
  hostResolvesPrivate,
  isPlainlyPrivateHost,
  isPrivateIssuerHost,
  readSsoConfig,
  recordSsoTest,
  saveSsoConfig,
  validateIssuer,
  validateSsoUpdate,
} from "./sso-server";
import { issuerFamily, type SsoConfig } from "./sso-types";
import { auditThrottled, AUDIT_LOG_PATH } from "./audit";

const claims = (c: Record<string, unknown>) => ({ iss: "x", aud: "y", exp: 0, iat: 0, sub: "s1", ...c }) as unknown as client.IDToken;
const GOOGLE = "https://accounts.google.com";
const ENTRA = "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0";
const OKTA = "https://example.okta.com/oauth2/default";

describe("issuerFamily", () => {
  it("follows the issuer's host, not the provider chosen in the menu", () => {
    assert.equal(issuerFamily(GOOGLE), "google");
    assert.equal(issuerFamily(ENTRA), "entra");
    assert.equal(issuerFamily("https://sts.windows.net/abc/"), "entra");
    // Microsoft's national clouds are Entra too.
    for (const host of ["login.microsoftonline.us", "login.partner.microsoftonline.cn", "login.chinacloudapi.cn"]) {
      assert.equal(issuerFamily(`https://${host}/11111111-2222-3333-4444-555555555555/v2.0`), "entra", host);
    }
    // Sign-up directories are not: anyone can make an account there.
    assert.equal(issuerFamily("https://contoso.b2clogin.com/abc/v2.0/"), "other");
    assert.equal(issuerFamily("https://login.microsoftonline.us.evil.example/abc/v2.0"), "other");
    assert.equal(issuerFamily(OKTA), "other");
    assert.equal(issuerFamily("https://accounts.google.com.evil.example"), "other");
    assert.equal(issuerFamily("not a url"), "other");
  });
});

describe("extractIdentity", () => {
  it("takes a verified email, and Google's hosted domain", () => {
    const id = extractIdentity(claims({ email: "Jane@Example.com", email_verified: true, hd: "example.com" }), "google");
    assert.equal(id.email, "jane@example.com");
    assert.equal(id.hostedDomain, "example.com");
  });

  it("refuses an email the provider didn't vouch for", () => {
    for (const c of [{ email: "jane@example.com" }, { email: "jane@example.com", email_verified: false }]) {
      assert.throws(() => extractIdentity(claims(c), "other"), (e) => e instanceof OidcFlowError && e.code === "email_unverified");
    }
  });

  it("on Entra, checks the address earlier releases checked: the email claim, then the sign-in name", () => {
    // An allowlist that names mail addresses must keep working after an
    // upgrade, also where the sign-in name is on another domain.
    const id = extractIdentity(claims({ email: "jane.doe@contoso.com", preferred_username: "jdoe@corp.onmicrosoft.com" }), "entra");
    assert.equal(id.email, "jane.doe@contoso.com");
    assert.equal(id.emailSource, "email");
    const noMail = extractIdentity(claims({ preferred_username: "jdoe@corp.onmicrosoft.com" }), "entra");
    assert.equal(noMail.email, "jdoe@corp.onmicrosoft.com");
    assert.equal(noMail.emailSource, "preferred_username");
  });

  it("on Entra too, refuses an address the provider says is unverified", () => {
    assert.throws(() => extractIdentity(claims({ email: "jane@example.com", email_verified: false }), "entra"), (e) => e instanceof OidcFlowError && e.code === "email_unverified");
  });

  it("gives no Entra leniency to an issuer that only calls itself Entra", () => {
    assert.throws(() => extractIdentity(claims({ preferred_username: "jane@example.com" }), "other"), (e) => e instanceof OidcFlowError && e.code === "email_unverified");
  });

  it("caps the detail an error carries", () => {
    assert.ok((new OidcFlowError("idp_error", "m", "x".repeat(20_000)).detail ?? "").length <= 301);
  });
});

describe("evaluateSsoAccess", () => {
  const cfg = (issuer: string, extra: Partial<SsoConfig> = {}) => ({
    issuer,
    allowedDomains: ["example.com"],
    allowedEmails: ["contractor@gmail.com"],
    allowAnyIdpUser: false,
    ...extra,
  });

  it("on Google, refuses a domain match from a personal account (no hosted domain)", () => {
    const decision = evaluateSsoAccess(cfg(GOOGLE), { email: "shared-inbox@example.com", hostedDomain: null });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /personal Google account/);
  });

  it("on Google, allows a domain match from an account in a Workspace", () => {
    assert.equal(evaluateSsoAccess(cfg(GOOGLE), { email: "jane@example.com", hostedDomain: "example.com" }).allowed, true);
  });

  it("allows an address on the explicit list without a hosted domain", () => {
    assert.equal(evaluateSsoAccess(cfg(GOOGLE), { email: "contractor@gmail.com", hostedDomain: null }).allowed, true);
  });

  it("never lets any Google account in, whatever the configuration says", () => {
    assert.equal(evaluateSsoAccess(cfg(GOOGLE, { allowAnyIdpUser: true, allowedDomains: [] }), { email: "a@gmail.com", hostedDomain: null }).allowed, false);
  });

  it("other providers: a domain match is enough", () => {
    assert.equal(evaluateSsoAccess(cfg(OKTA), { email: "jane@example.com", hostedDomain: null }).allowed, true);
  });
});

describe("addresses the server would fetch", () => {
  it("treats internal names and ranges as private", () => {
    for (const host of ["keycloak", "idp.corp", "idp.lan", "x.home.arpa", "100.64.1.1", "198.18.0.1", "224.0.0.1", "10.0.0.5", "::ffff:127.0.0.1"]) {
      assert.equal(isPrivateIssuerHost(host), true, host);
    }
    assert.equal(isPrivateIssuerHost("login.microsoftonline.com"), false);
  });

  it("checks what a name resolves to", async () => {
    assert.equal(await hostResolvesPrivate("localhost"), true);
    assert.equal(await hostResolvesPrivate("8.8.8.8"), false);
    const to = (...addresses: string[]) => async () => addresses.map((address) => ({ address }));
    for (const inside of ["10.0.0.5", "192.168.1.9", "172.20.0.2", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.5"]) {
      assert.equal(await hostResolvesPrivate("sso.example.com", to("203.0.113.7", inside)), true, inside);
    }
    assert.equal(await hostResolvesPrivate("sso.example.com", to("203.0.113.7", "2001:db8::1")), false);
    assert.equal(await hostResolvesPrivate("sso.example.com", async () => { throw new Error("ENOTFOUND"); }), false);
  });

  it("does not take a VPN's or a proxy's stand-in addresses for the server's own network", async () => {
    // "Fake IP" resolvers answer every name, Google's included, from
    // 198.18.0.0/15; carrier-grade NAT and Tailscale use 100.64.0.0/10.
    const to = (address: string) => async () => [{ address }];
    assert.equal(await hostResolvesPrivate("accounts.google.com", to("198.18.0.23")), false);
    assert.equal(await hostResolvesPrivate("login.microsoftonline.com", to("100.64.3.1")), false);
    // Written out in a URL they are still refused: nobody's provider lives there by name.
    assert.equal(isPrivateIssuerHost("198.18.0.23"), true);
  });

  it("holds an issuer already in use to the long-standing rule only", () => {
    // New: internal-looking names need the opt-in.
    assert.throws(() => validateIssuer("https://sso.corp"), /APP_SSO_ALLOW_PRIVATE_ISSUER/);
    assert.throws(() => validateIssuer("https://keycloak.lan/realms/main"), /APP_SSO_ALLOW_PRIVATE_ISSUER/);
    // Already saved: re-saving it unchanged must not start failing.
    assert.equal(validateIssuer("https://keycloak.lan/realms/main", { unchangedFrom: "https://keycloak.lan/realms/main" }), "https://keycloak.lan/realms/main");
    assert.equal(validateIssuer("https://keycloak.lan/realms/main/", { unchangedFrom: "https://keycloak.lan/realms/main" }), "https://keycloak.lan/realms/main");
    // What was always refused still is, saved or not.
    for (const always of ["https://idp.internal", "https://10.0.0.5", "https://localhost"]) {
      assert.throws(() => validateIssuer(always, { unchangedFrom: always }), /APP_SSO_ALLOW_PRIVATE_ISSUER/, always);
    }
    assert.equal(isPlainlyPrivateHost("keycloak.lan"), false);
    assert.equal(isPlainlyPrivateHost("100.64.1.1"), false);
    assert.equal(isPlainlyPrivateHost("::ffff:192.168.0.1"), true);
  });

  it("refuses a discovery-document address as the issuer", () => {
    assert.throws(() => validateIssuer("https://idp.example.com/.well-known/openid-configuration"), /not its discovery document/);
  });
});

describe("saving a configuration", () => {
  const base = {
    provider: "okta",
    issuer: OKTA,
    clientId: "client-1",
    clientSecret: "secret-1",
    redirectUri: "https://admin.example.com/api/auth/oidc/callback",
    allowedDomains: ["example.com"],
  };
  const existing = (extra: Partial<SsoConfig> = {}): SsoConfig =>
    ({
      ...validateSsoUpdate(base, null),
      ...extra,
    }) as SsoConfig;

  it("needs a new client secret when the issuer or client ID changes", () => {
    assert.throws(() => validateSsoUpdate({ clientId: "client-2" }, existing()), /enter the client secret/);
    assert.throws(() => validateSsoUpdate({ issuer: "https://other.okta.com/oauth2/default" }, existing()), /enter the client secret/);
    assert.equal(validateSsoUpdate({ clientId: "client-2", clientSecret: "secret-2" }, existing()).clientSecret, "secret-2");
    assert.equal(validateSsoUpdate({ displayName: "Staff sign-in" }, existing()).clientSecret, "secret-1");
  });

  it("refuses 'any account' for a Google issuer whatever the provider is called", () => {
    assert.throws(
      () => validateSsoUpdate({ ...base, provider: "generic", issuer: GOOGLE, allowedDomains: [], allowAnyIdpUser: true }, null),
      /restricted to specific domains/
    );
  });

  it("turns password sign-in off only with a passing test and the typed phrase", () => {
    const tested = existing({ lastTest: { at: "t", ok: true }, enabled: false });
    assert.throws(() => validateSsoUpdate({ enabled: true, passwordLoginEnabled: false }, existing()), /passing test/);
    assert.throws(() => validateSsoUpdate({ enabled: true, passwordLoginEnabled: false }, tested), /confirmation phrase/);
    const ok = validateSsoUpdate({ enabled: true, passwordLoginEnabled: false, confirm: "ENABLE SSO" }, tested);
    assert.deepEqual([ok.enabled, ok.passwordLoginEnabled], [true, false]);
  });

  it("turns password sign-in back on when a live password-free configuration's access changes", () => {
    const live = existing({ enabled: true, passwordLoginEnabled: false, lastTest: { at: "t", ok: true } });
    const edited = validateSsoUpdate({ allowedDomains: ["example.org"] }, live);
    assert.equal(edited.passwordLoginEnabled, true);
    assert.equal(edited.lastTest, undefined);
    // A cosmetic edit leaves it as it was.
    assert.equal(validateSsoUpdate({ displayName: "Staff" }, live).passwordLoginEnabled, false);
  });

  it("records a test result only against the configuration that was tested", async () => {
    const saved = await saveSsoConfig(base);
    assert.equal(await recordSsoTest({ at: "t", ok: true }, "an older version"), false);
    assert.equal(readSsoConfig()?.lastTest, undefined);
    assert.equal(await recordSsoTest({ at: "t", ok: true }, saved.updatedAt), true);
    assert.equal(readSsoConfig()?.lastTest?.ok, true);
    fs.rmSync(`${TEST_DATA_DIR}/sso.json`, { force: true });
  });
});

describe("a provider on the install's own network", () => {
  const doc = (issuer: string, over: Record<string, string> = {}) => ({
    issuer,
    authorization_endpoint: `${issuer}/auth`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/keys`,
    response_types_supported: ["code"],
    ...over,
  });
  /** Answer every fetch with this discovery document. */
  const serve = (document: object) =>
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify(document), { status: 200, headers: { "content-type": "application/json" } })
    );
  const resolvesTo = (address: string) =>
    mock.method(dnsPromises, "lookup", (async () => [{ address, family: 4 }]) as never);
  const client = (issuer: string, updatedAt: string) => ({ issuer, clientId: "c", clientSecret: "s", updatedAt });
  afterEach(() => mock.restoreAll());

  it("keeps working at sign-in when it was set up before the stricter check", async () => {
    // Worked in every earlier release: an internal name, resolving inside.
    const issuer = "https://keycloak.lan/realms/main";
    serve(doc(issuer));
    const lookups = resolvesTo("10.0.0.5");
    await loadOidcClient(client(issuer, "t1"));
    assert.equal(lookups.mock.callCount(), 0, "the name is not looked up at sign-in");
  });

  it("is refused when it is first set up, naming the setting that allows it", async () => {
    await assert.rejects(checkIssuer("https://keycloak.lan/realms/main"), /APP_SSO_ALLOW_PRIVATE_ISSUER/);
    // A public-looking name that points inside is caught by looking it up.
    resolvesTo("10.0.0.5");
    await assert.rejects(checkIssuer("https://sso.example.com"), /APP_SSO_ALLOW_PRIVATE_ISSUER/);
  });

  it("at sign-in, still refuses a discovery document that names some other internal host", async () => {
    const issuer = "https://sso.example.com";
    serve(doc(issuer, { token_endpoint: "https://tokens.corp/token" }));
    await assert.rejects(
      loadOidcClient(client(issuer, "t2")),
      /token endpoint points at a private or internal address/
    );
  });

  it("at sign-in, still refuses what was always refused", async () => {
    await assert.rejects(loadOidcClient(client("https://10.0.0.5", "t3")), /APP_SSO_ALLOW_PRIVATE_ISSUER/);
    await assert.rejects(loadOidcClient(client("https://idp.internal", "t4")), /APP_SSO_ALLOW_PRIVATE_ISSUER/);
  });

  it("is looked up when a configuration with a new issuer is saved, not when one in use is re-saved", async () => {
    const base = {
      provider: "okta",
      issuer: OKTA,
      clientId: "client-1",
      clientSecret: "secret-1",
      redirectUri: "https://admin.example.com/api/auth/oidc/callback",
      allowedDomains: ["example.com"],
    };
    try {
      const lookups = resolvesTo("203.0.113.7");
      await saveSsoConfig(base);
      assert.equal(lookups.mock.callCount(), 1);
      // From here the name points inside. The saved issuer stays usable...
      lookups.mock.mockImplementation((async () => [{ address: "10.0.0.5", family: 4 }]) as never);
      await saveSsoConfig({ allowedDomains: ["example.org"] });
      assert.equal(lookups.mock.callCount(), 1, "an unchanged issuer is not looked up again");
      assert.deepEqual(readSsoConfig()?.allowedDomains, ["example.org"]);
      // ...and a change to another one that points inside is refused, unwritten.
      await assert.rejects(
        saveSsoConfig({ issuer: "https://other.okta.com/oauth2/default", clientSecret: "secret-2" }),
        /APP_SSO_ALLOW_PRIVATE_ISSUER/
      );
      assert.equal(readSsoConfig()?.issuer, OKTA);
    } finally {
      fs.rmSync(`${TEST_DATA_DIR}/sso.json`, { force: true });
    }
  });
});

describe("the sign-in callback", () => {
  it("accepts each handshake once", () => {
    assert.equal(consumeHandshake("state-1"), true);
    assert.equal(consumeHandshake("state-1"), false);
    assert.equal(consumeHandshake("state-2"), true);
  });

  beforeEach(() => fs.rmSync(AUDIT_LOG_PATH, { force: true }));

  it("writes at most the limit of failure entries per client, then counts the rest", () => {
    const entry = { action: "auth.sso_login", tenantId: null, tenantName: null, params: {}, outcome: "error" as const };
    let written = 0;
    for (let i = 0; i < 500; i++) if (auditThrottled("sso-callback:anon", entry, 20, 60_000)) written++;
    assert.equal(written, 20);
    assert.equal(fs.readFileSync(AUDIT_LOG_PATH, "utf-8").trim().split("\n").length, 20);
  });
});
