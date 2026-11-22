/**
 * The tenant list on disk: an entry that can't be used, and the copy kept
 * between requests.
 */
import { TEST_DATA_DIR } from "./test-support/isolated-env";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { addTenant, getTenants, getTenantStoreSnapshot } from "./tenants-server";

const FILE = path.join(TEST_DATA_DIR, "tenants.json");
const good = { id: "t1", name: "Example", color: "blue", adminEmail: "admin@example.com", credentialsFile: "/keys/a.json" };

describe("tenants.json", () => {
  it("leaves out an entry it can't use instead of failing every route", () => {
    fs.writeFileSync(FILE, JSON.stringify({ activeTenantId: "t1", tenants: [good, null, { id: "t2" }, "junk"] }));
    assert.deepEqual(getTenants().map((t) => t.id), ["t1"]);
    assert.equal(getTenantStoreSnapshot().activeTenantId, "t1");
  });

  it("keeps the unusable entries in the file when it writes, for repair by hand", async () => {
    await addTenant({ name: "Second", color: "amber", adminEmail: "admin@second.example", credentialsFile: "/keys/b.json" });
    const onDisk = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    assert.equal(onDisk.tenants.length, 5);
    assert.deepEqual(onDisk.tenants.slice(-3), [null, { id: "t2" }, "junk"]);
    assert.deepEqual(getTenants().map((t) => t.name), ["Example", "Second"]);
  });

  it("sees a change made to the file by something else", () => {
    fs.writeFileSync(FILE, JSON.stringify({ activeTenantId: null, tenants: [{ ...good, name: "Renamed by hand, longer" }] }));
    assert.deepEqual(getTenants().map((t) => t.name), ["Renamed by hand, longer"]);
  });

  it("hands each caller its own copy", () => {
    getTenants()[0].name = "changed in memory";
    assert.equal(getTenants()[0].name, "Renamed by hand, longer");
  });
});
