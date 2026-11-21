/**
 * Single sign-on rules: whose identity is trusted, who may sign in, and what
 * the server refuses to save.
 */
import { TEST_DATA_DIR } from "./test-support/isolated-env";
import assert from "node:assert/strict";
import fs from "node:fs";
import { beforeEach, describe, it } from "node:test";
import type * as client from "openid-client";
import { evaluateSsoAccess, extractIdentity, OidcFlowError } from "./oidc";
import { consumeHandshake } from "./oidc-handshake";
import {
  hostResolvesPrivate,
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

  it("on Entra, prefers the user principal name over an unverified email claim", () => {
    const id = extractIdentity(claims({ email: "boss@example.com", preferred_username: "jane@example.com" }), "entra");
    assert.equal(id.email, "jane@example.com");
    assert.equal(id.emailSource, "preferred_username");
  });

  it("on Entra, uses the email claim only when Entra marks it verified", () => {
    assert.throws(() => extractIdentity(claims({ email: "boss@example.com" }), "entra"), (e) => e instanceof OidcFlowError && e.code === "no_email");
    assert.equal(extractIdentity(claims({ email: "jane@example.com", xms_edov: true }), "entra").email, "jane@example.com");
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
