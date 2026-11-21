/**
 * The scope checks, against the stand-in for Google's token endpoint.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { preflightTenantScopes, probeUnneededScopes, usedScopes } from "./preflight";
import type { Tenant } from "./tenant-types";
import {
  ADMIN,
  json,
  SERVICE_ACCOUNT_CLIENT_ID,
  installFakeGoogle,
} from "./test-support/fake-google";

const fake = installFakeGoogle();
const google = fake.google;
let tenant: Tenant;
before(() => {
  tenant = fake.tenant();
});
beforeEach(() => google.reset(() => undefined));

const GMAIL_FULL = "https://mail.google.com/";
const ROLES = "https://www.googleapis.com/auth/admin.directory.rolemanagement";
const GROUPS = "https://www.googleapis.com/auth/admin.directory.group";

describe("preflightTenantScopes", () => {
  it("reports every scope the app uses as authorised when the tenant granted them all", async () => {
    const result = await preflightTenantScopes(tenant);
    assert.equal(result.results.length, usedScopes().length);
    assert.ok(result.results.every((r) => r.authorized && r.error === null));
    assert.equal(result.adminEmail, ADMIN);
    assert.equal(result.serviceAccountClientId, SERVICE_ACCOUNT_CLIENT_ID);
  });

  it("asks for one scope at a time, as the admin", async () => {
    await preflightTenantScopes(tenant);
    assert.deepEqual(
      google.grants.map((g) => g.scopes).flat().sort(),
      usedScopes().sort()
    );
    assert.ok(google.grants.every((g) => g.subject === ADMIN && g.scopes.length === 1));
  });

  it("names the scope the tenant has not granted, with Google's reason", async () => {
    google.unauthorizedScopes.add(GROUPS);
    const result = await preflightTenantScopes(tenant);
    const missing = result.results.filter((r) => !r.authorized);
    assert.deepEqual(missing.map((r) => r.scope), [GROUPS]);
    assert.match(missing[0].error ?? "", /unauthorized_client/);
  });

  it("makes no Workspace API call, only token requests", async () => {
    await preflightTenantScopes(tenant);
    assert.equal(google.calls.length, 0);
  });
});

describe("probeUnneededScopes", () => {
  /** A tenant that granted exactly what the app uses, plus `extra`. */
  const grantOnly = (...extra: string[]) => {
    const granted = new Set([...usedScopes(), ...extra]);
    google.unauthorizedScopes = new Proxy(new Set<string>(), {
      get: (target, prop) =>
        prop === "has" ? (scope: string) => !granted.has(scope) : Reflect.get(target, prop),
    });
  };

  it("finds nothing on a key that was granted only what the app uses", async () => {
    grantOnly();
    const result = await probeUnneededScopes(tenant);
    assert.ok(result.probes.length >= 5);
    assert.ok(result.probes.every((p) => p.granted === false && p.error === null));
    assert.equal(result.serviceAccountClientId, SERVICE_ACCOUNT_CLIENT_ID);
  });

  it("reports exactly the broad access the key was given and doesn't need", async () => {
    grantOnly(GMAIL_FULL, ROLES);
    const result = await probeUnneededScopes(tenant);
    assert.deepEqual(
      result.probes.filter((p) => p.granted === true).map((p) => p.scope).sort(),
      [GMAIL_FULL, ROLES].sort()
    );
    const gmail = result.probes.find((p) => p.scope === GMAIL_FULL);
    assert.match(gmail?.meaning ?? "", /read, send and delete/);
  });

  it("never tests a scope the app actually uses", async () => {
    grantOnly();
    const result = await probeUnneededScopes(tenant);
    const used = new Set(usedScopes());
    assert.ok(result.probes.every((p) => !used.has(p.scope)));
  });

  it("does not mistake a failure to ask for a 'no'", async () => {
    google.tokenFailure = () => json({ error: "invalid_grant", error_description: "Invalid email or User ID" }, 400);
    const result = await probeUnneededScopes(tenant);
    assert.ok(result.probes.every((p) => p.granted === null), "unknown, not 'not granted'");
    assert.match(result.probes[0].error ?? "", /invalid_grant/);
  });

  it("reads and changes nothing: only token requests are made", async () => {
    grantOnly(GMAIL_FULL);
    await probeUnneededScopes(tenant);
    assert.equal(google.calls.length, 0);
  });

  it("refuses a tenant with no admin to impersonate or no key", async () => {
    await assert.rejects(probeUnneededScopes({ ...tenant, adminEmail: "" }), /adminEmail/);
    await assert.rejects(probeUnneededScopes({ ...tenant, credentialsFile: "" }), /credentialsFile/);
    await assert.rejects(
      probeUnneededScopes({ ...tenant, credentialsFile: "/nonexistent/key.json" }),
      /could not be read/
    );
  });
});
