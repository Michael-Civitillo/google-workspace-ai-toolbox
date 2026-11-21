/**
 * Reading and changing licences, against the stand-in for Google.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import {
  assignLicense,
  LicenseChangedError,
  licensingSetupProblem,
  LICENSING_SCOPE,
  listLicenseAssignments,
  removeLicense,
} from "./admin-sdk";
import { usedScopes } from "./preflight";
import { ValidationError } from "./validate";
import type { Tenant } from "./tenant-types";
import {
  ADMIN,
  googleError,
  installFakeGoogle,
  json,
  type Call,
} from "./test-support/fake-google";

const fake = installFakeGoogle();
const google = fake.google;
let tenant: Tenant;
before(() => {
  tenant = fake.tenant();
});

const CUSTOMER = "C01abc234";
const BASE = "/apps/licensing/v1/product";
const STANDARD = "1010020028";

const item = (userId: string, skuId = STANDARD) => ({
  userId,
  productId: "Google-Apps",
  productName: "Google Workspace",
  skuId,
  skuName: skuId === STANDARD ? "Google Workspace Business Standard" : skuId,
});

/** The admin's own account (for the customer id), then whatever `licensing` answers. */
const withLicensing = (licensing: (call: Call) => Response | undefined) => (call: Call) => {
  const path = decodeURIComponent(call.url.pathname);
  if (path === `/admin/directory/v1/users/${ADMIN}`) return json({ customerId: CUSTOMER });
  return path.startsWith(BASE) ? licensing(call) : undefined;
};

const licensingCalls = () => google.calls.filter((c) => c.url.pathname.startsWith(BASE));

beforeEach(() => google.reset(withLicensing(() => json({ items: [] }))));

describe("the licensing permission", () => {
  it("is one the preflight checks for", () => {
    assert.ok(usedScopes().includes(LICENSING_SCOPE));
  });

  // First in the file on purpose: once any test has been given a token for
  // this scope, the library reuses it and never asks Google for another.
  it("is recognised as missing when the tenant hasn't authorised it", async () => {
    google.unauthorizedScopes.add(LICENSING_SCOPE);
    const error = await listLicenseAssignments(tenant, { productId: "Google-Apps" }).then(
      () => null,
      (e) => e
    );
    assert.equal(licensingSetupProblem(error), "scope_missing");
    assert.equal(licensingCalls().length, 0);
  });
});

describe("listLicenseAssignments", () => {
  it("asks about one product, for this organisation, as the admin, with only the licensing scope", async () => {
    google.reset(
      withLicensing(() => json({ items: [item("Jane@Example.com")], nextPageToken: "next" }))
    );
    const page = await listLicenseAssignments(tenant, { productId: "Google-Apps" });
    const [call] = licensingCalls();
    assert.equal(licensingCalls().length, 1);
    assert.equal(call.method, "GET");
    assert.equal(call.url.pathname, `${BASE}/Google-Apps/users`);
    assert.equal(call.url.searchParams.get("customerId"), CUSTOMER);
    assert.equal(call.subject, ADMIN);
    assert.deepEqual(call.scopes, [LICENSING_SCOPE]);
    assert.deepEqual(page, {
      assignments: [
        {
          user: "jane@example.com",
          productId: "Google-Apps",
          productName: "Google Workspace",
          skuId: STANDARD,
          skuName: "Google Workspace Business Standard",
        },
      ],
      nextPageToken: "next",
      unavailable: false,
    });
  });

  it("passes the page token on", async () => {
    await listLicenseAssignments(tenant, { productId: "Google-Apps", pageToken: "next" });
    assert.equal(licensingCalls()[0].url.searchParams.get("pageToken"), "next");
  });

  it("treats a product Google doesn't know for this organisation as an ordinary answer", async () => {
    for (const status of [400, 404]) {
      google.reset(withLicensing(() => googleError(status, "Invalid productId", "invalid")));
      assert.deepEqual(await listLicenseAssignments(tenant, { productId: "101033" }), {
        assignments: [],
        nextPageToken: null,
        unavailable: true,
      });
    }
  });

  it("but not a refusal part-way through a list: that is a fault", async () => {
    google.reset(withLicensing(() => googleError(400, "Invalid page token", "invalid")));
    await assert.rejects(
      listLicenseAssignments(tenant, { productId: "Google-Apps", pageToken: "stale" }),
      /Invalid page token/
    );
  });

  it("refuses a product it doesn't ask about, before asking Google anything", async () => {
    await assert.rejects(
      listLicenseAssignments(tenant, { productId: "../../users" }),
      (e) => e instanceof ValidationError
    );
    assert.equal(google.calls.length, 0);
  });

  it("recognises a Cloud project with the licensing API switched off, and doesn't call it 'no such product'", async () => {
    google.reset(
      withLicensing(() =>
        googleError(
          403,
          "Enterprise License Manager API has not been used in project 123 before or it is disabled.",
          "accessNotConfigured"
        )
      )
    );
    const error = await listLicenseAssignments(tenant, { productId: "Google-Apps" }).then(
      () => null,
      (e) => e
    );
    assert.equal(licensingSetupProblem(error), "api_disabled");
  });

  it("doesn't mistake an ordinary refusal for a setup problem", () => {
    assert.equal(licensingSetupProblem(new Error("Backend Error")), null);
    assert.equal(licensingSetupProblem(null), null);
  });
});

describe("assignLicense", () => {
  const target = { user: "Jane@Example.com", productId: "Google-Apps", skuId: STANDARD };

  it("gives the account that licence", async () => {
    google.reset(withLicensing(() => json(item("jane@example.com"))));
    const assigned = await assignLicense(tenant, target);
    const [call] = licensingCalls();
    assert.equal(licensingCalls().length, 1);
    assert.equal(call.method, "POST");
    assert.equal(call.url.pathname, `${BASE}/Google-Apps/sku/${STANDARD}/user`);
    assert.deepEqual(call.body, { userId: "jane@example.com" });
    assert.deepEqual(call.scopes, [LICENSING_SCOPE]);
    assert.equal(assigned.user, "jane@example.com");
    assert.equal(assigned.skuName, "Google Workspace Business Standard");
  });

  it("never tries a second time when Google fails: a licence is paid for", async () => {
    google.reset(withLicensing(() => googleError(503, "Backend Error", "backendError")));
    await assert.rejects(assignLicense(tenant, target), /Backend Error/);
    assert.equal(licensingCalls().length, 1);
  });

  it("hands back Google's refusal, such as none left", async () => {
    google.reset(
      withLicensing(() => googleError(412, "Insufficient licenses to assign.", "conditionNotMet"))
    );
    await assert.rejects(assignLicense(tenant, target), /Insufficient licenses/);
  });

  it("refuses a bad address, product or licence id without asking Google", async () => {
    for (const bad of [
      { ...target, user: "not an address" },
      { ...target, productId: "Other" },
      { ...target, skuId: "a/b" },
      { ...target, skuId: "" },
    ]) {
      await assert.rejects(assignLicense(tenant, bad), (e) => e instanceof ValidationError);
    }
    assert.equal(google.calls.length, 0);
  });
});

describe("removeLicense", () => {
  const target = { user: "gone@example.com", productId: "Google-Apps", skuId: STANDARD };
  const path = `${BASE}/Google-Apps/sku/${STANDARD}/user/gone@example.com`;

  it("checks the account still holds it, then takes it away", async () => {
    google.reset(
      withLicensing((call) =>
        call.method === "GET" ? json(item("gone@example.com")) : new Response(null, { status: 204 })
      )
    );
    const removed = await removeLicense(tenant, target);
    assert.deepEqual(
      licensingCalls().map((c) => [c.method, decodeURIComponent(c.url.pathname)]),
      [["GET", path], ["DELETE", path]]
    );
    assert.deepEqual(removed, {
      user: "gone@example.com",
      skuName: "Google Workspace Business Standard",
    });
  });

  it("refuses when the account no longer holds that licence, and removes nothing", async () => {
    google.reset(withLicensing(() => googleError(404, "User does not have a license", "notFound")));
    await assert.rejects(removeLicense(tenant, target), (e) => e instanceof LicenseChangedError);
    assert.deepEqual(licensingCalls().map((c) => c.method), ["GET"]);
  });

  it("refuses the admin account it acts as, without asking Google", async () => {
    await assert.rejects(
      removeLicense(tenant, { ...target, user: ADMIN.toUpperCase() }),
      (e) => e instanceof ValidationError && /acts as/.test(e.message)
    );
    assert.equal(licensingCalls().length, 0);
  });

  it("refuses a bad licence id without asking Google", async () => {
    await assert.rejects(
      removeLicense(tenant, { ...target, skuId: "../x" }),
      (e) => e instanceof ValidationError
    );
    assert.equal(google.calls.length, 0);
  });
});
