/**
 * The licence rules, on made-up tenants.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isKnownProduct,
  isValidSkuId,
  LICENSE_IDLE_DAYS,
  reclaimReasonText,
  summariseLicenses,
  type LicenseAssignment,
} from "./licenses";
import type { DirectoryAccount } from "./security-check";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const account = (email: string, over: Partial<DirectoryAccount> = {}): DirectoryAccount => ({
  primaryEmail: email,
  fullName: email.split("@")[0],
  orgUnitPath: "/",
  isAdmin: false,
  isDelegatedAdmin: false,
  suspended: false,
  archived: false,
  enrolledIn2Sv: true,
  enforcedIn2Sv: false,
  lastLoginTime: daysAgo(1),
  creationTime: daysAgo(900),
  mailboxSetup: true,
  ...over,
});

const STANDARD = { productId: "Google-Apps", productName: "Google Workspace", skuId: "1010020028", skuName: "Business Standard" };
const STARTER = { productId: "Google-Apps", productName: "Google Workspace", skuId: "1010020027", skuName: "Business Starter" };
const ARCHIVED = { productId: "101034", productName: "Archived User", skuId: "1010340006", skuName: "Business Standard - Archived User" };
const FREE = { productId: "101001", productName: "Cloud Identity", skuId: "1010010001", skuName: "Cloud Identity Free" };
const VOICE = { productId: "101033", productName: "Google Voice", skuId: "1010330004", skuName: "Voice Standard" };
const holds = (user: string, sku: typeof STANDARD): LicenseAssignment => ({ user, ...sku });

const run = (assignments: LicenseAssignment[], accounts: DirectoryAccount[], allProductsRead = true) =>
  summariseLicenses(assignments, accounts, { now: NOW, allProductsRead });

describe("summariseLicenses", () => {
  it("counts holders per licence type, most used first", () => {
    const report = run(
      [holds("a@x.co", STARTER), holds("b@x.co", STANDARD), holds("c@x.co", STANDARD)],
      [account("a@x.co"), account("b@x.co"), account("c@x.co")]
    );
    assert.deepEqual(
      report.skus.map((s) => [s.skuName, s.assigned, s.reclaimable]),
      [["Business Standard", 2, 0], ["Business Starter", 1, 0]]
    );
    assert.deepEqual(report.reclaimable, []);
  });

  it("reports a licence on a suspended account", () => {
    const report = run([holds("gone@x.co", STANDARD)], [account("gone@x.co", { suspended: true })]);
    assert.deepEqual(
      report.reclaimable.map((r) => [r.user, r.reason, r.skuName, reclaimReasonText(r)]),
      [["gone@x.co", "suspended", "Business Standard", "Suspended"]]
    );
    assert.equal(report.skus[0].reclaimable, 1);
  });

  it("reports a licence on an account nobody has signed in to for a long time", () => {
    const report = run(
      [holds("idle@x.co", STANDARD), holds("recent@x.co", STANDARD)],
      [
        account("idle@x.co", { lastLoginTime: daysAgo(LICENSE_IDLE_DAYS) }),
        account("recent@x.co", { lastLoginTime: daysAgo(LICENSE_IDLE_DAYS - 1) }),
      ]
    );
    assert.deepEqual(
      report.reclaimable.map((r) => [r.user, reclaimReasonText(r)]),
      [["idle@x.co", `No sign-in for ${LICENSE_IDLE_DAYS} days`]]
    );
  });

  it("measures a never-used account from its creation, so a new hire isn't reported", () => {
    const never = { lastLoginTime: null };
    const report = run(
      [holds("new@x.co", STANDARD), holds("forgotten@x.co", STANDARD)],
      [
        account("new@x.co", { ...never, creationTime: daysAgo(5) }),
        account("forgotten@x.co", { ...never, creationTime: daysAgo(300) }),
      ]
    );
    assert.deepEqual(
      report.reclaimable.map((r) => [r.user, reclaimReasonText(r)]),
      [["forgotten@x.co", "Never signed in (created 300 days ago)"]]
    );
  });

  it("doesn't call an account idle when Google gives no dates for it", () => {
    const report = run(
      [holds("mystery@x.co", STANDARD)],
      [account("mystery@x.co", { lastLoginTime: null, creationTime: null })]
    );
    assert.deepEqual(report.reclaimable, []);
  });

  it("never suggests reclaiming an archived-user licence or a free one", () => {
    const report = run(
      [holds("parked@x.co", ARCHIVED), holds("idle@x.co", FREE), holds("out@x.co", FREE)],
      [
        account("parked@x.co", { archived: true, lastLoginTime: daysAgo(700) }),
        account("idle@x.co", { lastLoginTime: daysAgo(700) }),
        account("out@x.co", { suspended: true }),
      ]
    );
    assert.deepEqual(report.reclaimable, []);
    assert.ok(report.skus.every((s) => s.reclaimable === 0));
  });

  it("lists every licence a suspended account holds, suspended before idle, longest idle first", () => {
    const report = run(
      [
        holds("idle200@x.co", STANDARD),
        holds("out@x.co", STANDARD),
        holds("out@x.co", VOICE),
        holds("idle500@x.co", STARTER),
      ],
      [
        account("idle200@x.co", { lastLoginTime: daysAgo(200) }),
        account("out@x.co", { suspended: true }),
        account("idle500@x.co", { lastLoginTime: daysAgo(500) }),
      ]
    );
    assert.deepEqual(
      report.reclaimable.map((r) => [r.user, r.skuName]),
      [
        ["out@x.co", "Business Standard"],
        ["out@x.co", "Voice Standard"],
        ["idle500@x.co", "Business Starter"],
        ["idle200@x.co", "Business Standard"],
      ]
    );
  });

  it("matches holders to accounts whatever the letter case", () => {
    const report = run([holds("Out@X.co", STANDARD)], [account("out@x.co", { suspended: true })]);
    assert.equal(report.reclaimable.length, 1);
    assert.equal(report.unknownHolders, 0);
    assert.deepEqual(report.unlicensed, []);
  });

  it("counts, and doesn't judge, a licence whose holder isn't in the directory", () => {
    const report = run([holds("renamed@x.co", STANDARD)], [account("someone@x.co")]);
    assert.equal(report.unknownHolders, 1);
    assert.deepEqual(report.reclaimable, []);
    assert.equal(report.skus[0].assigned, 1);
  });

  it("lists active accounts that hold no licence at all", () => {
    const report = run(
      [holds("a@x.co", STANDARD), holds("only-voice@x.co", VOICE)],
      [
        account("a@x.co"),
        account("only-voice@x.co"),
        account("none@x.co"),
        account("none-suspended@x.co", { suspended: true }),
        account("none-archived@x.co", { archived: true }),
      ]
    );
    assert.deepEqual(report.unlicensed, [{ user: "none@x.co", name: "none" }]);
  });

  it("claims nobody is unlicensed when a product couldn't be read", () => {
    const report = run([holds("a@x.co", STANDARD)], [account("a@x.co"), account("none@x.co")], false);
    assert.deepEqual(report.unlicensed, []);
  });
});

describe("request checks", () => {
  it("knows the products it asks about and no others", () => {
    assert.ok(isKnownProduct("Google-Apps"));
    assert.ok(isKnownProduct("101034"));
    for (const bad of ["google-apps", "", "101999", "../x", null, 101034]) {
      assert.equal(isKnownProduct(bad), false, String(bad));
    }
  });

  it("accepts SKU ids and nothing that could reach another path", () => {
    assert.ok(isValidSkuId("1010020028"));
    assert.ok(isValidSkuId("Google-Apps-For-Business"));
    for (const bad of ["", "a/b", "a b", "..", "x".repeat(65), "a?b", null]) {
      assert.equal(isValidSkuId(bad), false, String(bad));
    }
  });
});
