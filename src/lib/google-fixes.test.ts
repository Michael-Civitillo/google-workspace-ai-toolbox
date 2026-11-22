/**
 * Drive, Gmail and Directory behaviour fixed after the 0.3.0 review, against
 * the stand-in for Google: scans that could not read something say so, Drive
 * transfers count each item once, imports report what lost its labels, and
 * the admin account is recognised by account rather than by the address typed.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import {
  assertNotImpersonatedAdmin,
  buildInitialTransferCursor,
  changePrimaryDomain,
  getUser,
  importMessageBatch,
  isAlreadyExistsError,
  listExternallySharedDriveFiles,
  listExternallySharedFiles,
  NoSuchAccountError,
  resolveImportLabels,
  revokeAllOAuthTokens,
  revokeExternalPermissions,
  transferDriveFoldersOwnership,
  withGoogleRetry,
} from "./admin-sdk";
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

const DOMAINS = {
  domains: [
    {
      domainName: "example.com",
      isPrimary: true,
      verified: true,
      domainAliases: [{ domainAliasName: "example.net", verified: true }],
    },
    { domainName: "example.org", isPrimary: false, verified: true },
  ],
};

/** Accounts by every address that reaches them, with their ids. */
const USERS: Record<string, { id: string; primaryEmail: string }> = {
  [ADMIN]: { id: "1", primaryEmail: ADMIN },
  "boss@example.com": { id: "1", primaryEmail: ADMIN },
  "alice@example.com": { id: "2", primaryEmail: "alice@example.com" },
  "ali@example.com": { id: "2", primaryEmail: "alice@example.com" },
  "bob@example.com": { id: "3", primaryEmail: "bob@example.com" },
  "robert@example.com": { id: "3", primaryEmail: "bob@example.com" },
};
const USERS_PATH = "/admin/directory/v1/users";

/** Domains and user lookups, then whatever `rest` answers. */
const withDirectory =
  (rest: (call: Call, path: string) => Response | undefined = () => undefined) =>
  (call: Call) => {
    const path = decodeURIComponent(call.url.pathname);
    if (path.endsWith("/customer/my_customer/domains")) return json(DOMAINS);
    if (call.method === "GET" && /^\/admin\/directory\/v1\/users\/[^/]+$/.test(path)) {
      const found = USERS[path.slice(USERS_PATH.length + 1).toLowerCase()];
      return found
        ? json({ ...found, name: { fullName: "Someone" } })
        : googleError(404, "Resource Not Found: userKey", "notFound");
    }
    return rest(call, path);
  };

// A refusal the retry layer passes straight through, so a test needn't sit
// out a backoff.
const refused = () => googleError(403, "The user does not have sufficient permissions for this file.", "insufficientFilePermissions");

const perm = (email: string, extra: Record<string, unknown> = {}) => ({
  id: `p-${email}`,
  type: "user",
  role: "writer",
  emailAddress: email,
  ...extra,
});

describe("per-user sharing scan", () => {
  it("does not pass a heavily shared file as clean when its full list can't be read", async () => {
    // Drive cuts the inline list off at 100; the outside grant may be past it.
    const inline = Array.from({ length: 100 }, (_, i) => perm(`u${i}@example.com`));
    google.reset(
      withDirectory((call, path) => {
        if (path === "/drive/v3/files") {
          return json({ files: [{ id: "big", name: "Budget", permissions: inline }] });
        }
        if (path === "/drive/v3/files/big/permissions") return refused();
        return undefined;
      })
    );
    const result = await listExternallySharedFiles(tenant, "alice@example.com");
    assert.equal(result.files.length, 0);
    assert.equal(result.unreadableCount, 1);
    assert.equal(result.unreadable[0].id, "big");
    assert.equal(result.unreadable[0].name, "Budget");
    assert.match(result.unreadable[0].error, /sufficient permissions/);
  });

  it("counts a permission with no address instead of calling it internal", async () => {
    google.reset(
      withDirectory((call, path) => {
        if (path === "/drive/v3/files") {
          return json({
            files: [
              {
                id: "f1",
                name: "Notes",
                permissions: [perm("alice@example.com", { role: "owner" }), { id: "x", type: "user", role: "reader" }],
              },
            ],
          });
        }
        return undefined;
      })
    );
    const result = await listExternallySharedFiles(tenant, "alice@example.com");
    assert.equal(result.files.length, 0);
    assert.equal(result.unidentifiedPermissions, 1);
    assert.equal(result.unreadableCount, 0);
  });

  it("stops when the caller has gone", async () => {
    google.reset(withDirectory());
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      listExternallySharedFiles(tenant, "alice@example.com", undefined, { signal: ac.signal }),
      (e: Error) => /abort|cancel/i.test(e.message) || e.name === "AbortError"
    );
    assert.equal(google.callsTo("/drive/v3/files").length, 0, "no Drive call made");
  });
});

describe("shared drive scan", () => {
  it("reports a file whose sharing it could not read, instead of skipping it", async () => {
    google.reset(
      withDirectory((call, path) => {
        if (path === "/drive/v3/files") {
          return json({
            files: [
              { id: "ok", name: "Plan", hasAugmentedPermissions: true },
              { id: "locked", name: "Contract", hasAugmentedPermissions: true },
            ],
          });
        }
        if (path === "/drive/v3/files/ok/permissions") {
          return json({ permissions: [perm("partner@outside.org", { permissionDetails: [{ inherited: false }] })] });
        }
        if (path === "/drive/v3/files/locked/permissions") return refused();
        return undefined;
      })
    );
    const result = await listExternallySharedDriveFiles(tenant, {
      driveId: "0AbCdEfGh",
      asUsers: ["alice@example.com"],
    });
    assert.deepEqual(result.files.map((f) => f.id), ["ok"]);
    assert.equal(result.unreadableCount, 1);
    assert.equal(result.unreadable[0].id, "locked");
  });
});

describe("removing outside sharing", () => {
  const FILE = "/drive/v3/files/doc1";
  const outside = perm("partner@outside.org");

  it("does not call an inherited permission gone when the admin can't reach the file", async () => {
    google.reset(
      withDirectory((call, path) => {
        if (path === FILE) return json({ id: "doc1", name: "Plan" });
        if (path === `${FILE}/permissions` && call.method === "GET") return json({ permissions: [outside] });
        if (call.method === "DELETE") {
          // The owner may not remove an inherited grant; the admin can't see
          // the file at all.
          return call.subject === "alice@example.com"
            ? googleError(403, "The permission is inherited and cannot be deleted.", "cannotDeletePermission")
            : googleError(404, "File not found: doc1.", "notFound");
        }
        return undefined;
      })
    );
    const result = await revokeExternalPermissions(tenant, "alice@example.com", ["doc1"]);
    const outcome = result.results[0];
    assert.equal(outcome.removed, 0);
    assert.equal(outcome.errors.length, 1, "reported as a failure, not as nothing to remove");
    assert.match(outcome.errors[0].message, /probably still shared/);
  });

  it("says a batch cut short in the middle of a file was cut short", async () => {
    const ac = new AbortController();
    google.reset(
      withDirectory((call, path) => {
        if (path === FILE) return json({ id: "doc1", name: "Plan" });
        if (path === `${FILE}/permissions` && call.method === "GET") {
          return json({ permissions: [perm("a@outside.org"), perm("b@outside.org")] });
        }
        if (call.method === "DELETE") {
          ac.abort(); // The operator leaves while the first delete is in flight.
          return new Response(null, { status: 204 });
        }
        return undefined;
      })
    );
    const result = await revokeExternalPermissions(tenant, "alice@example.com", ["doc1"], {
      signal: ac.signal,
    });
    assert.equal(result.aborted, true);
    assert.equal(result.results[0].removed, 1);
    assert.equal(result.results[0].stoppedEarly, true, "the second grant was never tried");
  });
});

describe("Drive folder transfer", () => {
  const FOLDER = "application/vnd.google-apps.folder";
  /** A selected folder holding one subfolder, which holds one file. */
  const tree = (call: Call, path: string, owners: Record<string, string>) => {
    if (path === "/drive/v3/files" && call.method === "GET") {
      const q = call.url.searchParams.get("q") ?? "";
      const kids: Record<string, unknown[]> = {
        folderTop001: [{ id: "folderSub001", name: "Sub", mimeType: FOLDER, ownedByMe: true, permissions: [perm("alice@example.com", { role: "owner" })] }],
        folderSub001: [{ id: "fileDoc00001", name: "Doc", mimeType: "text/plain", ownedByMe: true, permissions: [perm("alice@example.com", { role: "owner" })] }],
      };
      const parent = /'([^']+)' in parents/.exec(q)?.[1] ?? "";
      return json({ files: kids[parent] ?? [] });
    }
    const permList = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(path);
    if (permList && call.method === "GET") {
      const owner = owners[permList[1]] ?? "alice@example.com";
      return json({ permissions: [perm(owner, { role: "owner" })] });
    }
    if (permList && call.method === "POST") {
      owners[permList[1]] = "bob@example.com";
      return json({ id: "new", role: "owner" });
    }
    return undefined;
  };

  it("transfers a subfolder once, not once as a child and again as a folder", async () => {
    const owners: Record<string, string> = {};
    google.reset(withDirectory((call, path) => tree(call, path, owners)));
    let cursor = buildInitialTransferCursor(["folderTop001"]);
    const totals = { transferred: 0, alreadyOwned: 0, notOwned: 0, errors: 0 };
    for (let i = 0; i < 10; i++) {
      const out = await transferDriveFoldersOwnership(tenant, "alice@example.com", "bob@example.com", cursor);
      totals.transferred += out.transferred;
      totals.alreadyOwned += out.alreadyOwned;
      totals.notOwned += out.notOwned;
      totals.errors += out.errors.length;
      if (!out.nextCursor) break;
      cursor = out.nextCursor;
    }
    assert.deepEqual(totals, { transferred: 3, alreadyOwned: 0, notOwned: 0, errors: 0 });
    const creates = google.calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/permissions"));
    assert.deepEqual(
      creates.map((c) => c.url.pathname.split("/")[4]).sort(),
      ["fileDoc00001", "folderSub001", "folderTop001"],
      "one ownership grant per item"
    );
    // Children came with their permissions: only the selected folder itself
    // needed its own permissions.list.
    const lists = google.calls.filter((c) => c.method === "GET" && c.url.pathname.endsWith("/permissions"));
    assert.deepEqual(lists.map((c) => c.url.pathname.split("/")[4]), ["folderTop001"]);
  });

  it("recognises the receiver by account when an alias was typed", async () => {
    // Everything already belongs to bob; the operator typed his alias.
    const owners: Record<string, string> = { folderTop001: "bob@example.com" };
    google.reset(
      withDirectory((call, path) => {
        if (path === "/drive/v3/files" && call.method === "GET") return json({ files: [] });
        return tree(call, path, owners);
      })
    );
    const out = await transferDriveFoldersOwnership(
      tenant,
      "alice@example.com",
      "robert@example.com",
      buildInitialTransferCursor(["folderTop001"])
    );
    assert.equal(out.alreadyOwned, 1);
    assert.equal(out.transferred, 0);
    assert.equal(google.calls.filter((c) => c.method === "POST").length, 0, "no second transfer sent");
  });

  it("refuses an address that reaches no account", async () => {
    google.reset(withDirectory());
    await assert.rejects(
      transferDriveFoldersOwnership(tenant, "alice@example.com", "nobody@example.com", buildInitialTransferCursor(["folderTop001"])),
      NoSuchAccountError
    );
  });
});

describe("the admin account guard", () => {
  beforeEach(() => google.reset(withDirectory()));

  it("refuses the admin by primary address, by alias, and by another address on it", async () => {
    for (const address of [ADMIN, "Boss@Example.com"]) {
      await assert.rejects(assertNotImpersonatedAdmin(tenant, address, "offboard"), ValidationError, address);
    }
  });

  it("compares accounts when the tenant names its admin by an alias", async () => {
    // The tenant was set up with the admin's alias; the operator types the
    // admin's primary address. The addresses differ, the account doesn't.
    const aliased = { ...tenant, id: "t-aliased", adminEmail: "boss@example.com" };
    await assert.rejects(assertNotImpersonatedAdmin(aliased, ADMIN, "suspend"), ValidationError);
  });

  it("lets anyone else through, and says when an address reaches no account", async () => {
    await assertNotImpersonatedAdmin(tenant, "ali@example.com", "offboard");
    await assert.rejects(assertNotImpersonatedAdmin(tenant, "nobody@example.com", "offboard"), NoSuchAccountError);
  });
});

describe("Domain Change", () => {
  it("names the new address after the account, not after the alias typed", async () => {
    let renamedTo = "";
    let renamedKey = "";
    google.reset(
      withDirectory((call, path) => {
        if (call.method === "PUT" && path.startsWith(`${USERS_PATH}/`)) {
          renamedKey = path.slice(USERS_PATH.length + 1);
          renamedTo = (call.body as { primaryEmail: string }).primaryEmail;
          // Now the new address reaches the account, for the read-back.
          USERS[renamedTo] = { id: "2", primaryEmail: renamedTo };
          return json({ primaryEmail: renamedTo });
        }
        return undefined;
      })
    );
    try {
      // Typed by one of Alice's aliases. The username must come from
      // "alice", not "ali".
      const result = await changePrimaryDomain(tenant, "ali@example.com", "example.org");
      assert.equal(renamedTo, "alice@example.org");
      assert.equal(renamedKey, "alice@example.com", "renames the account by its own address");
      assert.equal(result.previousEmail, "alice@example.com");
      assert.equal(result.newEmail, "alice@example.org");
      assert.equal(result.verifiedNewPrimary, "alice@example.org");
    } finally {
      delete USERS["alice@example.org"];
    }
  });
});

describe("token revoke", () => {
  it("counts a token that is already gone as revoked, not failed", async () => {
    google.reset(
      withDirectory((call, path) => {
        if (path === `${USERS_PATH}/alice@example.com/tokens` && call.method === "GET") {
          return json({ items: [{ clientId: "app-1", displayText: "One" }, { clientId: "app-2", displayText: "Two" }] });
        }
        if (call.method === "DELETE" && path.endsWith("/tokens/app-1")) return new Response(null, { status: 204 });
        if (call.method === "DELETE" && path.endsWith("/tokens/app-2")) {
          return googleError(404, "Resource Not Found: clientId", "notFound");
        }
        return undefined;
      })
    );
    const result = await revokeAllOAuthTokens(tenant, "alice@example.com");
    assert.deepEqual(result, { revoked: 2, failed: 0, errors: [] });
  });
});

describe("mailbox import", () => {
  const MESSAGES = "/gmail/v1/users/me/messages";

  it("reports a message that was stored without its labels", async () => {
    const bodies: unknown[] = [];
    google.reset((call) => {
      if (call.url.pathname !== MESSAGES || call.method !== "POST") return undefined;
      bodies.push(call.body);
      const labels = (call.body as { labelIds?: string[] }).labelIds;
      return labels ? googleError(400, "Invalid label: Label_9", "invalidArgument") : json({ id: "m1" });
    });
    const result = await importMessageBatch(tenant, "alice@example.com", [{ raw: "UmF3", labelIds: ["Label_9"] }]);
    assert.equal(result.inserted, 1);
    assert.deepEqual(result.insertedWithoutLabels, [0]);
    assert.equal(bodies.length, 2);
  });

  it("does not strip the labels to get past a rate limit", async () => {
    google.reset((call) => {
      if (call.url.pathname !== MESSAGES || call.method !== "POST") return undefined;
      return googleError(403, "Daily limit exceeded", "dailyLimitExceeded");
    });
    const result = await importMessageBatch(tenant, "alice@example.com", [{ raw: "UmF3", labelIds: ["INBOX"] }]);
    assert.equal(result.inserted, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.insertedWithoutLabels, undefined);
    assert.equal(google.calls.filter((c) => c.method === "POST").length, 1, "no label-less second insert");
  });

  it("says which labels could not be created", async () => {
    google.reset((call) => {
      const path = call.url.pathname;
      if (path !== "/gmail/v1/users/me/labels") return undefined;
      if (call.method === "GET") return json({ labels: [{ id: "Label_1", name: "Projects", type: "user" }] });
      const name = (call.body as { name: string }).name;
      return name === "Broken"
        ? googleError(400, "Invalid label name", "invalidArgument")
        : json({ id: "Label_new", name });
    });
    const result = await resolveImportLabels(tenant, "alice@example.com", [
      { id: "Label_a", name: "projects", type: "user" },
      { id: "Label_b", name: "Fresh", type: "user" },
      { id: "Label_c", name: "Broken", type: "user" },
      { id: "Label_d", name: "", type: "user" },
      { id: "INBOX", name: "INBOX", type: "system" },
    ]);
    assert.deepEqual(result.map, { Label_a: "Label_1", Label_b: "Label_new", INBOX: "INBOX" });
    assert.equal(result.unmappedCount, 2);
    assert.deepEqual(result.unmapped.map((u) => u.id).sort(), ["Label_c", "Label_d"]);
  });
});

describe("a call that gets no answer", () => {
  // The shapes Node's fetch gives a failed connection: "fetch failed", with
  // the real reason a level down.
  const failed = (code: string, reason: string) =>
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(reason), { code }),
    });
  const dnsBlip = () => failed("EAI_AGAIN", "getaddrinfo EAI_AGAIN admin.googleapis.com");
  const reset = () => failed("ECONNRESET", "read ECONNRESET");
  const aliceLookup = (call: Call) =>
    call.method === "GET" && decodeURIComponent(call.url.pathname) === `${USERS_PATH}/alice@example.com`;

  it("is tried again, through the real client, and succeeds once the blip has passed", async () => {
    let tries = 0;
    google.reset((call) => {
      if (!aliceLookup(call)) return undefined;
      if (++tries === 1) throw dnsBlip();
      return json({ id: "2", primaryEmail: "alice@example.com", name: { fullName: "Alice" } });
    });
    const user = await getUser(tenant, "alice@example.com");
    assert.equal(user.primaryEmail, "alice@example.com");
    assert.equal(tries, 2);
  });

  it("is given up on after three tries, so being offline is said quickly", async () => {
    let tries = 0;
    google.reset((call) => {
      if (!aliceLookup(call)) return undefined;
      tries++;
      throw dnsBlip();
    });
    const started = Date.now();
    await assert.rejects(getUser(tenant, "alice@example.com"), /fetch failed/);
    assert.equal(tries, 3);
    assert.ok(Date.now() - started < 4000, "not the long back-off kept for 'slow down'");
  });

  it("re-sends a write only when nothing can have been sent", async () => {
    const count = async (make: () => Error, retryServerErrors: boolean) => {
      let tries = 0;
      await assert.rejects(
        withGoogleRetry(
          async () => {
            tries++;
            throw make();
          },
          { retryServerErrors }
        )
      );
      return tries;
    };
    // A connection that dropped part-way may have delivered the request.
    assert.equal(await count(reset, false), 1, "a write is not repeated after a reset");
    assert.equal(await count(reset, true), 3, "a read is");
    // The name never resolved: nothing left this machine.
    assert.equal(await count(dnsBlip, false), 3, "safe to send again, even a write");
    // An error of our own making is not a connection problem.
    assert.equal(await count(() => new Error("userEmail must be a valid email address"), true), 1);
  });
});

describe("isAlreadyExistsError", () => {
  const err = (status: number, message: string) =>
    Object.assign(new Error(message), { response: { status, data: { error: { message } } } });

  it("trusts a 409, and a 400 that says duplicate", () => {
    assert.equal(isAlreadyExistsError(err(409, "Conflict")), true);
    assert.equal(isAlreadyExistsError(err(400, "Duplicate forwarding address")), true);
  });

  it("does not take a server error or a refusal that mentions it for success", () => {
    assert.equal(isAlreadyExistsError(err(500, "Backend error: entity already exists?")), false);
    assert.equal(isAlreadyExistsError(err(403, "Label already exists but you may not use it")), false);
    assert.equal(isAlreadyExistsError(new Error("already exists")), false);
  });
});
