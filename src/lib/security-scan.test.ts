/**
 * The Security Check scan, run against a stand-in for Google.
 *
 * The real function is called with a real (throwaway) service-account key; only
 * the network is replaced. That exercises what unit tests of the rules cannot:
 * which endpoints are called, as whom and with which scope, how a page is put
 * together, and what happens when one account's calls fail.
 *
 * The stand-in lives in test-support/fake-google.ts.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import {
  changePrimaryDomain,
  deleteForwardingFilter,
  disableAutoForwarding,
  isAbortError,
  isExternalTarget,
  listDomains,
  listDelegationChanges,
  listExternallySharedDriveFiles,
  listSharedDrives,
  revokeAppForUser,
  scanSecurityPage,
  SecurityFixStaleError,
  serviceAccountClientId,
} from "./admin-sdk";
import type { Tenant } from "./tenant-types";
import {
  ADMIN,
  googleError,
  json,
  installFakeGoogle,
  type Handler,
} from "./test-support/fake-google";

const BASIC_SETTINGS = "https://www.googleapis.com/auth/gmail.settings.basic";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12);
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();
const NEVER = "1970-01-01T00:00:00.000Z";
const DOMAINS = new Set(["example.com"]);

const fake = installFakeGoogle();
const google = fake.google;
let tenant: Tenant;
before(() => {
  tenant = fake.tenant();
});

/** A directory user as the Admin SDK returns it. */
function user(email: string, overrides: Record<string, unknown> = {}) {
  return {
    primaryEmail: email,
    name: { fullName: email.split("@")[0] },
    orgUnitPath: "/",
    isAdmin: false,
    isDelegatedAdmin: false,
    suspended: false,
    archived: false,
    isEnrolledIn2Sv: true,
    isEnforcedIn2Sv: false,
    lastLoginTime: daysAgo(2),
    creationTime: daysAgo(800),
    isMailboxSetup: true,
    ...overrides,
  };
}

interface Mailbox {
  forwarding?: unknown;
  filters?: unknown[];
  tokens?: unknown[];
  /** Replace a response outright, to simulate Google refusing. */
  forwardingResponse?: () => Response;
  filtersResponse?: () => Response;
  tokensResponse?: () => Response;
}

/**
 * A tenant: one page of directory users plus what each mailbox and token list
 * holds. Anything not listed answers the way an untouched account would.
 */
function tenantOf(
  users: unknown[],
  mailboxes: Record<string, Mailbox> = {},
  nextPageToken?: string
): Handler {
  return (call) => {
    const p = call.url.pathname;
    if (p === "/admin/directory/v1/users") {
      return json({ users, nextPageToken });
    }
    const tokens = p.match(/^\/admin\/directory\/v1\/users\/([^/]+)\/tokens$/);
    if (tokens) {
      const box = mailboxes[decodeURIComponent(tokens[1])] ?? {};
      return box.tokensResponse?.() ?? json({ items: box.tokens ?? [] });
    }
    // Gmail calls name the mailbox only through whose token they carry.
    const box = mailboxes[call.subject ?? ""] ?? {};
    if (p === "/gmail/v1/users/me/settings/autoForwarding") {
      return box.forwardingResponse?.() ?? json(box.forwarding ?? { enabled: false });
    }
    if (p === "/gmail/v1/users/me/settings/filters") {
      return box.filtersResponse?.() ?? json({ filter: box.filters ?? [] });
    }
    return undefined;
  };
}

const scan = (opts: Partial<Parameters<typeof scanSecurityPage>[1]> = {}) =>
  scanSecurityPage(tenant, { verifiedDomains: DOMAINS, now: NOW, ...opts });

describe("scanSecurityPage", () => {
  beforeEach(() => google.reset(() => undefined));

  it("reports nothing for a tenant with nothing wrong", async () => {
    google.reset(tenantOf([user("alice@example.com"), user("bob@example.com")]));
    const page = await scan();
    assert.deepEqual(page, {
      accounts: 2,
      skippedSuspended: 0,
      activeAccounts: 2,
      admins: 0,
      withoutTwoStep: [],
      inactive: [],
      mailboxesChecked: 2,
      withoutMailbox: 0,
      externalForwarding: [],
      internalForwards: 0,
      mailboxErrors: [],
      appsChecked: 2,
      apps: [],
      appErrors: [],
      nextPageToken: null,
    });
  });

  it("finds each kind of problem and attributes it to the right account", async () => {
    google.reset(
      tenantOf(
        [
          user(ADMIN, { isAdmin: true, isEnrolledIn2Sv: false }),
          user("alice@example.com"),
          user("bob@example.com", { isEnrolledIn2Sv: false, lastLoginTime: daysAgo(200) }),
          user("carol@example.com", { suspended: true, isEnrolledIn2Sv: false }),
          user("dave@example.com", {
            isMailboxSetup: false,
            lastLoginTime: NEVER,
            creationTime: daysAgo(400),
          }),
          user("erin@example.com", { archived: true }),
        ],
        {
          "alice@example.com": {
            forwarding: { enabled: true, emailAddress: "alice@gmail.com", disposition: "trash" },
            tokens: [
              {
                clientId: "crm.apps.googleusercontent.com",
                displayText: "Acme CRM",
                scopes: ["https://mail.google.com/", "openid"],
              },
            ],
          },
          "bob@example.com": {
            forwarding: { enabled: true, emailAddress: "team@example.com", disposition: "archive" },
            filters: [
              {
                id: "f1",
                criteria: { from: "bank@example.net" },
                action: { forward: "drop@evil.net" },
              },
              { id: "f2", criteria: { subject: "rota" }, action: { addLabelIds: ["L1"] } },
            ],
            tokens: [
              {
                clientId: "crm.apps.googleusercontent.com",
                displayText: "Acme CRM",
                scopes: ["https://www.googleapis.com/auth/calendar"],
                nativeApp: true,
              },
              {
                clientId: "notes.apps.googleusercontent.com",
                displayText: "Notes",
                scopes: ["openid", "email"],
                anonymous: true,
              },
            ],
          },
        }
      )
    );

    const page = await scan();

    assert.equal(page.accounts, 6);
    assert.equal(page.skippedSuspended, 2, "suspended and archived accounts are skipped");
    assert.equal(page.activeAccounts, 4);
    assert.equal(page.admins, 1);

    assert.deepEqual(
      page.withoutTwoStep.map((f) => [f.user, f.admin]),
      [
        [ADMIN, true],
        ["bob@example.com", false],
      ]
    );
    assert.deepEqual(
      page.inactive.map((f) => [f.user, f.idleDays, f.lastLoginTime]),
      [
        ["bob@example.com", 200, daysAgo(200)],
        ["dave@example.com", 400, null],
      ]
    );

    assert.equal(page.withoutMailbox, 1, "dave has no mailbox to read");
    assert.equal(page.mailboxesChecked, 3);
    assert.equal(page.internalForwards, 1, "bob's forward to a colleague is not a finding");
    assert.deepEqual(page.externalForwarding, [
      {
        user: "alice@example.com",
        name: "alice",
        kind: "auto-forward",
        target: "alice@gmail.com",
        detail: "Forwards all mail; deletes the original",
        hidesOriginal: true,
        filterId: null,
      },
      {
        user: "bob@example.com",
        name: "bob",
        kind: "filter",
        target: "drop@evil.net",
        detail: "Filter on from:bank@example.net",
        hidesOriginal: false,
        filterId: "f1",
      },
    ]);

    assert.equal(page.appsChecked, 4);
    assert.deepEqual(page.apps, [
      {
        clientId: "crm.apps.googleusercontent.com",
        name: "Acme CRM",
        scopes: [
          "https://mail.google.com/",
          "https://www.googleapis.com/auth/calendar",
          "openid",
        ],
        anonymous: false,
        nativeApp: true,
        users: ["alice@example.com", "bob@example.com"],
      },
      {
        clientId: "notes.apps.googleusercontent.com",
        name: "Notes",
        scopes: ["email", "openid"],
        anonymous: true,
        nativeApp: false,
        users: ["bob@example.com"],
      },
    ]);
    assert.deepEqual(page.mailboxErrors, []);
    assert.deepEqual(page.appErrors, []);
  });

  it("never touches the mailbox or tokens of a suspended or archived account", async () => {
    google.reset(
      tenantOf([
        user("alice@example.com"),
        user("carol@example.com", { suspended: true }),
        user("erin@example.com", { archived: true }),
      ])
    );
    await scan();
    const touched = new Set(
      google.calls
        .filter((c) => c.url.pathname !== "/admin/directory/v1/users")
        .map((c) =>
          c.url.pathname.startsWith("/gmail/")
            ? c.subject
            : decodeURIComponent(c.url.pathname.split("/")[5])
        )
    );
    assert.deepEqual([...touched], ["alice@example.com"]);
  });

  it("reads each mailbox as its owner with only the settings scope, and the directory as the admin", async () => {
    google.reset(tenantOf([user("alice@example.com"), user("bob@example.com")]));
    await scan();

    const gmailCalls = google.calls.filter((c) => c.url.host === "gmail.googleapis.com");
    assert.equal(gmailCalls.length, 4, "two settings reads per mailbox");
    for (const call of gmailCalls) {
      assert.equal(call.method, "GET");
      assert.deepEqual(call.scopes, [BASIC_SETTINGS], "nothing broader than basic settings");
      assert.ok(call.subject?.endsWith("@example.com") && call.subject !== ADMIN);
    }
    assert.deepEqual(
      [...new Set(gmailCalls.map((c) => c.subject))].sort(),
      ["alice@example.com", "bob@example.com"]
    );

    const directoryCalls = google.calls.filter((c) => c.url.host === "admin.googleapis.com");
    assert.equal(directoryCalls.length, 3, "one listing and one token list per account");
    for (const call of directoryCalls) {
      assert.equal(call.method, "GET");
      assert.equal(call.subject, ADMIN);
    }
    assert.ok(
      google.calls.every((c) => c.method === "GET"),
      "the scan must not write anything"
    );
  });

  it("asks the directory for exactly the fields the checks need", async () => {
    google.reset(tenantOf([user("alice@example.com")], {}, "next-page"));
    const page = await scan({ pageToken: "page-2", pageSize: 25 });

    const [listing] = google.callsTo("/admin/directory/v1/users");
    const q = listing.url.searchParams;
    assert.equal(q.get("customer"), "my_customer");
    assert.equal(q.get("maxResults"), "25");
    assert.equal(q.get("pageToken"), "page-2");
    assert.equal(q.get("projection"), "basic");
    for (const field of [
      "isEnrolledIn2Sv",
      "lastLoginTime",
      "creationTime",
      "isMailboxSetup",
      "archived",
      "suspended",
      "isDelegatedAdmin",
      "nextPageToken",
    ]) {
      assert.ok(q.get("fields")?.includes(field), `fields should include ${field}`);
    }
    assert.equal(page.nextPageToken, "next-page");
  });

  it("caps the page size", async () => {
    google.reset(tenantOf([]));
    await scan({ pageSize: 5000 });
    assert.equal(
      google.callsTo("/admin/directory/v1/users")[0].url.searchParams.get("maxResults"),
      "100"
    );
  });

  it("handles a page with no accounts", async () => {
    google.reset(() => json({}));
    const page = await scan();
    assert.equal(page.accounts, 0);
    assert.equal(page.nextPageToken, null);
    assert.equal(google.calls.length, 1);
  });

  it("reports an unreadable mailbox against that account and carries on", async () => {
    const refuse = () =>
      googleError(400, "Mail service not enabled", "failedPrecondition");
    google.reset(
      tenantOf([user("alice@example.com"), user("bob@example.com")], {
        "alice@example.com": { forwardingResponse: refuse, filtersResponse: refuse },
        "bob@example.com": {
          forwarding: { enabled: true, emailAddress: "bob@gmail.com", disposition: "leaveInInbox" },
        },
      })
    );
    const page = await scan();
    assert.equal(page.mailboxesChecked, 1);
    assert.equal(page.mailboxErrors.length, 1);
    assert.equal(page.mailboxErrors[0].user, "alice@example.com");
    assert.match(page.mailboxErrors[0].error, /forwarding setting: Mail service not enabled/);
    assert.match(page.mailboxErrors[0].error, /filters: Mail service not enabled/);
    assert.deepEqual(
      page.externalForwarding.map((f) => f.user),
      ["bob@example.com"],
      "the other mailbox is still reported"
    );
    assert.equal(page.appsChecked, 2, "the app check does not depend on the mailbox");
  });

  it("keeps what a half-readable mailbox did answer", async () => {
    google.reset(
      tenantOf([user("alice@example.com")], {
        "alice@example.com": {
          forwarding: { enabled: true, emailAddress: "alice@gmail.com", disposition: "leaveInInbox" },
          filtersResponse: () => googleError(403, "Filters are disabled", "forbidden"),
        },
      })
    );
    const page = await scan();
    assert.equal(page.externalForwarding.length, 1, "the forward it found is not thrown away");
    assert.equal(page.mailboxesChecked, 1);
    assert.deepEqual(page.mailboxErrors, [
      { user: "alice@example.com", error: "filters: Filters are disabled" },
    ]);
  });

  it("reports an unreadable token list against that account and carries on", async () => {
    google.reset(
      tenantOf([user("alice@example.com"), user("bob@example.com")], {
        "alice@example.com": {
          tokensResponse: () => googleError(403, "Not Authorized to access this resource/api", "forbidden"),
        },
        "bob@example.com": {
          tokens: [{ clientId: "x", displayText: "X", scopes: ["openid"] }],
        },
      })
    );
    const page = await scan();
    assert.equal(page.appsChecked, 1);
    assert.deepEqual(page.appErrors, [
      { user: "alice@example.com", error: "Not Authorized to access this resource/api" },
    ]);
    assert.deepEqual(
      page.apps.map((a) => [a.clientId, a.users]),
      [["x", ["bob@example.com"]]]
    );
    assert.equal(page.mailboxesChecked, 2);
  });

  it("rides out a rate limit instead of reporting it as a failure", async () => {
    let refusals = 0;
    google.reset(
      tenantOf([user("alice@example.com")], {
        "alice@example.com": {
          tokensResponse: () => {
            if (refusals++ === 0) {
              return googleError(429, "Rate Limit Exceeded", "rateLimitExceeded");
            }
            return json({ items: [{ clientId: "x", displayText: "X", scopes: ["openid"] }] });
          },
        },
      })
    );
    const page = await scan();
    assert.equal(refusals, 2, "one refusal, one retry");
    assert.deepEqual(page.appErrors, []);
    assert.equal(page.apps.length, 1);
  });

  it("fails the page when the directory itself can't be listed", async () => {
    google.reset(() =>
      googleError(403, "Not Authorized to access this resource/api", "forbidden")
    );
    await assert.rejects(scan(), /Not Authorized/);
  });

  it("stops without reporting failures when the request is cancelled", async () => {
    const controller = new AbortController();
    const inner = tenantOf(
      Array.from({ length: 30 }, (_, i) => user(`user${String(i).padStart(2, "0")}@example.com`))
    );
    google.reset((call) => {
      // Cancel as soon as the per-account work begins.
      if (call.url.pathname !== "/admin/directory/v1/users") controller.abort();
      return inner(call);
    });
    await assert.rejects(scan({ signal: controller.signal }), (e) => isAbortError(e));
    assert.ok(
      google.calls.length < 30,
      `a cancelled scan should stop early, made ${google.calls.length} calls`
    );
  });

  it("does not start at all for a request that is already cancelled", async () => {
    google.reset(tenantOf([user("alice@example.com")]));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(scan({ signal: controller.signal }), (e) => isAbortError(e));
    assert.equal(google.calls.length, 0);
  });

  it("merges an app's grants across the accounts on a page", async () => {
    const app = (scopes: string[]) => ({
      clientId: "shared.apps.googleusercontent.com",
      displayText: "Shared",
      scopes,
    });
    google.reset(
      tenantOf(
        [user("a@example.com"), user("b@example.com"), user("c@example.com")],
        {
          "a@example.com": { tokens: [app(["openid"])] },
          "b@example.com": { tokens: [app(["openid", "email"])] },
          "c@example.com": { tokens: [app(["https://www.googleapis.com/auth/drive"])] },
        }
      )
    );
    const page = await scan();
    assert.equal(page.apps.length, 1);
    assert.deepEqual(page.apps[0].users, ["a@example.com", "b@example.com", "c@example.com"]);
    assert.deepEqual(page.apps[0].scopes, [
      "email",
      "https://www.googleapis.com/auth/drive",
      "openid",
    ]);
  });
});

const REPORTS = "https://www.googleapis.com/auth/admin.reports.audit.readonly";
const ACTIVITY_PATH = "/admin/reports/v1/activity/users/all/applications/admin";

/** An admin log item as the Reports API returns it. */
function logItem(
  time: string,
  actor: string,
  name: string,
  parameters: Array<Record<string, unknown>>
) {
  return {
    id: { time, applicationName: "admin" },
    actor: { email: actor },
    events: [{ type: "DOMAIN_SETTINGS", name, parameters }],
  };
}

describe("listDelegationChanges", () => {
  beforeEach(() => google.reset(() => undefined));

  it("reads grants and removals from the admin log", async () => {
    google.reset((call) => {
      if (call.url.pathname !== ACTIVITY_PATH) return undefined;
      const event = call.url.searchParams.get("eventName");
      if (event === "AUTHORIZE_API_CLIENT_ACCESS") {
        return json({
          items: [
            logItem("2026-11-01T10:00:00.000Z", "admin@example.com", event, [
              { name: "API_CLIENT_NAME", value: "111222333" },
              {
                name: "API_SCOPES",
                value: "https://mail.google.com/,https://www.googleapis.com/auth/drive",
              },
              { name: "DOMAIN_NAME", value: "example.com" },
            ]),
            logItem("2026-10-01T10:00:00.000Z", "other@example.com", event, [
              { name: "API_CLIENT_NAME", value: "tool.apps.googleusercontent.com" },
              { name: "API_SCOPES", multiValue: ["https://www.googleapis.com/auth/calendar"] },
            ]),
          ],
        });
      }
      if (event === "REMOVE_API_CLIENT_ACCESS") {
        return json({
          items: [
            logItem("2026-11-10T10:00:00.000Z", "admin@example.com", event, [
              { name: "API_CLIENT_NAME", value: "tool.apps.googleusercontent.com" },
            ]),
          ],
        });
      }
      return json({});
    });

    const { events, truncated } = await listDelegationChanges(tenant, { now: NOW });
    assert.equal(truncated, false);
    assert.deepEqual(events, [
      {
        time: "2026-11-01T10:00:00.000Z",
        actor: "admin@example.com",
        kind: "authorize",
        clientId: "111222333",
        scopes: ["https://mail.google.com/", "https://www.googleapis.com/auth/drive"],
      },
      {
        time: "2026-10-01T10:00:00.000Z",
        actor: "other@example.com",
        kind: "authorize",
        clientId: "tool.apps.googleusercontent.com",
        scopes: ["https://www.googleapis.com/auth/calendar"],
      },
      {
        time: "2026-11-10T10:00:00.000Z",
        actor: "admin@example.com",
        kind: "remove",
        clientId: "tool.apps.googleusercontent.com",
        scopes: [],
      },
    ]);
  });

  it("asks only for delegation events, six months back, as the admin with the reports scope", async () => {
    google.reset(() => json({}));
    await listDelegationChanges(tenant, { now: NOW });

    assert.equal(google.calls.length, 2, "one request per event name when there is one page each");
    assert.deepEqual(
      google.calls.map((c) => c.url.searchParams.get("eventName")),
      ["AUTHORIZE_API_CLIENT_ACCESS", "REMOVE_API_CLIENT_ACCESS"]
    );
    for (const call of google.calls) {
      assert.equal(call.method, "GET");
      assert.equal(call.url.pathname, ACTIVITY_PATH);
      assert.equal(call.subject, ADMIN);
      assert.deepEqual(call.scopes, [REPORTS]);
      assert.equal(
        call.url.searchParams.get("startTime"),
        new Date(NOW - 180 * DAY).toISOString()
      );
    }
  });

  it("follows the log across pages", async () => {
    google.reset((call) => {
      if (call.url.searchParams.get("eventName") !== "AUTHORIZE_API_CLIENT_ACCESS") return json({});
      const token = call.url.searchParams.get("pageToken");
      const item = (n: number) =>
        logItem(`2026-11-0${n}T00:00:00.000Z`, "admin@example.com", "AUTHORIZE_API_CLIENT_ACCESS", [
          { name: "API_CLIENT_NAME", value: `client-${n}` },
          { name: "API_SCOPES", value: "openid" },
        ]);
      if (!token) return json({ items: [item(1)], nextPageToken: "p2" });
      if (token === "p2") return json({ items: [item(2)], nextPageToken: "p3" });
      return json({ items: [item(3)] });
    });
    const { events, truncated } = await listDelegationChanges(tenant, { now: NOW });
    assert.deepEqual(
      events.map((e) => e.clientId),
      ["client-1", "client-2", "client-3"]
    );
    assert.equal(truncated, false);
  });

  it("says so when the log is longer than it will read", async () => {
    google.reset((call) =>
      call.url.searchParams.get("eventName") === "AUTHORIZE_API_CLIENT_ACCESS"
        ? json({ items: [], nextPageToken: "more" })
        : json({})
    );
    const { truncated } = await listDelegationChanges(tenant, { now: NOW });
    assert.equal(truncated, true);
    assert.equal(
      google.calls.filter(
        (c) => c.url.searchParams.get("eventName") === "AUTHORIZE_API_CLIENT_ACCESS"
      ).length,
      5,
      "stops at its page limit"
    );
  });

  it("ignores other events and entries with no client", async () => {
    google.reset((call) =>
      call.url.searchParams.get("eventName") === "AUTHORIZE_API_CLIENT_ACCESS"
        ? json({
            items: [
              logItem("2026-11-01T00:00:00.000Z", "admin@example.com", "CHANGE_PASSWORD", [
                { name: "API_CLIENT_NAME", value: "not-a-delegation-event" },
              ]),
              logItem("2026-11-01T00:00:00.000Z", "admin@example.com", "AUTHORIZE_API_CLIENT_ACCESS", [
                { name: "API_SCOPES", value: "openid" },
              ]),
            ],
          })
        : json({})
    );
    assert.deepEqual((await listDelegationChanges(tenant, { now: NOW })).events, []);
  });

  it("fails loudly when the admin log can't be read", async () => {
    google.reset(() =>
      googleError(403, "Not Authorized to access this resource/api", "forbidden")
    );
    await assert.rejects(listDelegationChanges(tenant, { now: NOW }), /Not Authorized/);
  });

  it("stops when the request is cancelled", async () => {
    google.reset(() => json({}));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      listDelegationChanges(tenant, { now: NOW, signal: controller.signal }),
      (e) => isAbortError(e)
    );
    assert.equal(google.calls.length, 0);
  });
});

describe("serviceAccountClientId", () => {
  it("reads the client id from the tenant's key file", () => {
    assert.equal(serviceAccountClientId(tenant), "100200300400500600700");
  });

  it("is null when there is no key file to read", () => {
    assert.equal(
      serviceAccountClientId({ ...tenant, credentialsFile: "/nonexistent/key.json" }),
      null
    );
  });
});

const SHARING_SETTINGS = "https://www.googleapis.com/auth/gmail.settings.sharing";
const FORWARDING_PATH = "/gmail/v1/users/me/settings/autoForwarding";
const writes = () => google.calls.filter((c) => c.method !== "GET");

describe("disableAutoForwarding", () => {
  beforeEach(() => google.reset(() => undefined));

  it("turns forwarding off when it still points where the operator saw it", async () => {
    let body: unknown = null;
    google.reset((call) => {
      if (call.url.pathname !== FORWARDING_PATH) return undefined;
      if (call.method === "GET") {
        return json({ enabled: true, emailAddress: "Out@Evil.net", disposition: "trash" });
      }
      body = call.body;
      return json({ enabled: false });
    });
    const result = await disableAutoForwarding(tenant, "alice@example.com", "out@evil.net");
    assert.deepEqual(result, { changed: true, previousTarget: "out@evil.net" });
    assert.equal(writes().length, 1);
    assert.equal(writes()[0].method, "PUT");
    assert.deepEqual(body, { enabled: false });
    for (const call of google.calls) {
      assert.equal(call.subject, "alice@example.com", "acts as the mailbox owner");
      // Reading the setting first needs gmail.settings.basic: Google does not
      // accept .sharing for getAutoForwarding, so with .sharing alone the
      // check-before-write could never run.
      assert.deepEqual(call.scopes, [BASIC_SETTINGS, SHARING_SETTINGS]);
    }
  });

  it("writes nothing when forwarding is already off", async () => {
    google.reset(() => json({ enabled: false, emailAddress: "out@evil.net" }));
    assert.deepEqual(await disableAutoForwarding(tenant, "alice@example.com", "out@evil.net"), {
      changed: false,
      previousTarget: null,
    });
    assert.equal(writes().length, 0);
  });

  it("refuses, and writes nothing, when the mailbox now forwards somewhere else", async () => {
    google.reset(() => json({ enabled: true, emailAddress: "someone-else@example.org" }));
    await assert.rejects(
      disableAutoForwarding(tenant, "alice@example.com", "out@evil.net"),
      (e) => e instanceof SecurityFixStaleError && /someone-else@example\.org/.test(e.message)
    );
    assert.equal(writes().length, 0);
  });

  it("rejects something that isn't an address before calling Google", async () => {
    await assert.rejects(disableAutoForwarding(tenant, "not-an-address", "out@evil.net"));
    assert.equal(google.calls.length, 0);
  });
});

describe("deleteForwardingFilter", () => {
  beforeEach(() => google.reset(() => undefined));
  const FILTER_PATH = "/gmail/v1/users/me/settings/filters/abc123";

  it("deletes the filter when it still forwards where the operator saw it", async () => {
    google.reset((call) => {
      if (call.url.pathname !== FILTER_PATH) return undefined;
      return call.method === "GET"
        ? json({ id: "abc123", criteria: {}, action: { forward: "drop@evil.net" } })
        : new Response(null, { status: 204 });
    });
    assert.deepEqual(
      await deleteForwardingFilter(tenant, "bob@example.com", "abc123", "Drop@Evil.net"),
      { changed: true }
    );
    assert.deepEqual(
      google.calls.map((c) => [c.method, c.url.pathname, c.subject]),
      [
        ["GET", FILTER_PATH, "bob@example.com"],
        ["DELETE", FILTER_PATH, "bob@example.com"],
      ]
    );
    assert.deepEqual(google.calls[1].scopes, [BASIC_SETTINGS]);
  });

  it("refuses to delete a filter that doesn't forward there", async () => {
    google.reset(() => json({ id: "abc123", action: { addLabelIds: ["Label_1"] } }));
    await assert.rejects(
      deleteForwardingFilter(tenant, "bob@example.com", "abc123", "drop@evil.net"),
      (e) => e instanceof SecurityFixStaleError
    );
    assert.equal(writes().length, 0, "a filter that only labels mail must survive");
  });

  it("treats a filter that is already gone as done", async () => {
    google.reset(() => googleError(404, "Filter not found", "notFound"));
    assert.deepEqual(
      await deleteForwardingFilter(tenant, "bob@example.com", "abc123", "drop@evil.net"),
      { changed: false }
    );
    assert.equal(writes().length, 0);
  });

  it("rejects a malformed filter id before calling Google", async () => {
    for (const id of ["", "../etc", "a b", "x".repeat(201)]) {
      await assert.rejects(
        deleteForwardingFilter(tenant, "bob@example.com", id, "drop@evil.net"),
        /malformed/
      );
    }
    assert.equal(google.calls.length, 0);
  });
});

describe("revokeAppForUser", () => {
  beforeEach(() => google.reset(() => undefined));
  const CLIENT = "1002-merge.apps.googleusercontent.com";
  const TOKEN_PATH = `/admin/directory/v1/users/bob%40example.com/tokens/${CLIENT}`;

  it("deletes that app's token for that account, as the admin", async () => {
    google.reset((call) =>
      call.method === "DELETE" ? new Response(null, { status: 204 }) : undefined
    );
    assert.deepEqual(await revokeAppForUser(tenant, "bob@example.com", CLIENT), {
      changed: true,
    });
    assert.equal(google.calls.length, 1);
    assert.equal(google.calls[0].method, "DELETE");
    assert.equal(decodeURIComponent(google.calls[0].url.pathname), decodeURIComponent(TOKEN_PATH));
    assert.equal(google.calls[0].subject, ADMIN);
  });

  it("treats an app that is no longer connected as done", async () => {
    google.reset(() => googleError(404, "Token not found", "notFound"));
    assert.deepEqual(await revokeAppForUser(tenant, "bob@example.com", CLIENT), {
      changed: false,
    });
  });

  it("surfaces a refusal instead of calling it done", async () => {
    google.reset(() => googleError(403, "Not Authorized to access this resource/api", "forbidden"));
    await assert.rejects(revokeAppForUser(tenant, "bob@example.com", CLIENT), /Not Authorized/);
  });

  it("rejects a client id that could change the request path", async () => {
    for (const id of ["", "a/b", "a b", "x?y", "x#y", "x".repeat(301)]) {
      await assert.rejects(revokeAppForUser(tenant, "bob@example.com", id), /malformed/);
    }
    assert.equal(google.calls.length, 0);
  });
});

describe("listDomains and domain aliases", () => {
  const DOMAINS_PATH = "/admin/directory/v1/customer/my_customer/domains";
  const tenantDomains = () =>
    json({
      domains: [
        {
          domainName: "Example.com",
          isPrimary: true,
          verified: true,
          domainAliases: [
            { domainAliasName: "example.net", parentDomainName: "example.com", verified: true },
            { domainAliasName: "pending.example", parentDomainName: "example.com", verified: false },
          ],
        },
        { domainName: "example.org", isPrimary: false, verified: true },
      ],
    });
  // The list is cached per tenant for a minute; a fresh id per test keeps them apart.
  let n = 0;
  const freshTenant = () => ({ ...tenant, id: `alias-test-${++n}` });

  beforeEach(() =>
    google.reset((call) => (call.url.pathname === DOMAINS_PATH ? tenantDomains() : undefined))
  );

  it("lists aliases beside the domains they mirror, marked as aliases", async () => {
    assert.deepEqual(await listDomains(freshTenant()), [
      { domainName: "example.com", isPrimary: true, verified: true, isAlias: false },
      { domainName: "example.org", isPrimary: false, verified: true, isAlias: false },
      { domainName: "example.net", isPrimary: false, verified: true, isAlias: true },
      { domainName: "pending.example", isPrimary: false, verified: false, isAlias: true },
    ]);
  });

  it("treats an address at a verified alias as inside the organisation", async () => {
    const t = freshTenant();
    assert.equal(await isExternalTarget(t, "pat@example.net"), false);
    assert.equal(await isExternalTarget(t, "pat@example.org"), false);
  });

  it("still treats an unverified alias, and everything else, as outside", async () => {
    const t = freshTenant();
    assert.equal(await isExternalTarget(t, "pat@pending.example"), true);
    assert.equal(await isExternalTarget(t, "pat@gmail.com"), true);
  });

  it("stays fail-closed when the domains can't be listed", async () => {
    google.reset(() => googleError(403, "Not Authorized to access this resource/api", "forbidden"));
    assert.equal(await isExternalTarget(freshTenant(), "pat@example.com"), true);
  });

  it("refuses to move a user's primary email onto an alias", async () => {
    await assert.rejects(
      changePrimaryDomain(freshTenant(), "pat@example.com", "example.net"),
      /domain alias/
    );
    assert.ok(
      google.calls.every((c) => c.method === "GET"),
      "refused before anything was written"
    );
  });
});

const DRIVE_FULL = "https://www.googleapis.com/auth/drive";
const DRIVE_METADATA = "https://www.googleapis.com/auth/drive.metadata.readonly";
const DOMAINS_PATH = "/admin/directory/v1/customer/my_customer/domains";
const oneDomain = () =>
  json({ domains: [{ domainName: "example.com", isPrimary: true, verified: true }] });

describe("listSharedDrives", () => {
  // The domain list is cached per tenant; a fresh id keeps each test's own.
  let n = 0;
  const t = () => ({ ...tenant, id: `drives-test-${++n}` });
  beforeEach(() => google.reset(() => undefined));

  /** A tenant with the given drives and their members. */
  const drives = (
    list: Array<{ id: string; name: string }>,
    members: Record<string, unknown[] | (() => Response)>,
    nextPageToken?: string
  ): Handler => (call) => {
    const p = call.url.pathname;
    if (p === DOMAINS_PATH) return oneDomain();
    if (p === "/drive/v3/drives") return json({ drives: list, nextPageToken });
    const perms = p.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/);
    if (perms) {
      const answer = members[perms[1]];
      return typeof answer === "function" ? answer() : json({ permissions: answer ?? [] });
    }
    return undefined;
  };

  it("reports who outside the organisation is a member of each drive", async () => {
    google.reset(
      drives(
        [
          { id: "drive-sales", name: "Sales" },
          { id: "drive-legal", name: "Legal" },
        ],
        {
          "drive-sales": [
            { type: "user", role: "organizer", emailAddress: "Lead@Example.com" },
            { type: "user", role: "writer", emailAddress: "agency@partner.example" },
            { type: "group", role: "reader", emailAddress: "everyone@example.com" },
            { type: "domain", role: "reader", domain: "partner.example" },
          ],
          "drive-legal": [{ type: "user", role: "reader", emailAddress: "counsel@example.com" }],
        }
      )
    );
    const page = await listSharedDrives(t());
    assert.equal(page.nextPageToken, null);
    assert.deepEqual(page.drives, [
      {
        id: "drive-sales",
        name: "Sales",
        externalMembers: [
          { type: "user", role: "writer", target: "agency@partner.example" },
          { type: "domain", role: "reader", target: "partner.example", allowFileDiscovery: null },
        ],
        memberCount: 4,
        scanCandidates: ["lead@example.com"],
        error: null,
      },
      {
        id: "drive-legal",
        name: "Legal",
        externalMembers: [],
        memberCount: 1,
        scanCandidates: ["counsel@example.com"],
        error: null,
      },
    ]);
  });

  it("offers the most senior internal people to scan as, never groups or outsiders", async () => {
    google.reset(
      drives([{ id: "drive-x", name: "X" }], {
        "drive-x": [
          { type: "user", role: "reader", emailAddress: "a-reader@example.com" },
          { type: "user", role: "organizer", emailAddress: "z-manager@example.com" },
          { type: "user", role: "writer", emailAddress: "m-writer@example.com" },
          { type: "user", role: "fileOrganizer", emailAddress: "c-content@example.com" },
          { type: "user", role: "organizer", emailAddress: "outsider@partner.example" },
          { type: "group", role: "organizer", emailAddress: "admins@example.com" },
          { type: "user", role: "organizer", emailAddress: "gone@example.com", deleted: true },
        ],
      })
    );
    const [drive] = (await listSharedDrives(t())).drives;
    assert.deepEqual(drive.scanCandidates, [
      "z-manager@example.com",
      "c-content@example.com",
      "m-writer@example.com",
    ]);
  });

  it("has no one to scan as when a drive's members are all groups", async () => {
    google.reset(
      drives([{ id: "drive-g", name: "Groups only" }], {
        "drive-g": [{ type: "group", role: "organizer", emailAddress: "team@example.com" }],
      })
    );
    assert.deepEqual((await listSharedDrives(t())).drives[0].scanCandidates, []);
  });

  it("asks as the admin with domain admin access, and only reads", async () => {
    google.reset(drives([{ id: "drive-x", name: "X" }], { "drive-x": [] }, "more"));
    const page = await listSharedDrives(t(), { pageToken: "p2", pageSize: 500 });
    assert.equal(page.nextPageToken, "more");
    const listing = google.callsTo("/drive/v3/drives")[0];
    assert.equal(listing.url.searchParams.get("useDomainAdminAccess"), "true");
    assert.equal(listing.url.searchParams.get("pageToken"), "p2");
    assert.equal(listing.url.searchParams.get("pageSize"), "50", "capped");
    const members = google.callsTo("/permissions")[0];
    assert.equal(members.url.searchParams.get("useDomainAdminAccess"), "true");
    assert.equal(members.url.searchParams.get("supportsAllDrives"), "true");
    for (const call of google.calls.filter((c) => c.url.pathname.startsWith("/drive/"))) {
      assert.equal(call.method, "GET");
      assert.equal(call.subject, ADMIN);
      assert.deepEqual(call.scopes, [DRIVE_FULL]);
    }
  });

  it("reports a drive whose members can't be read without losing the others", async () => {
    google.reset(
      drives(
        [
          { id: "drive-bad", name: "Bad" },
          { id: "drive-ok", name: "OK" },
        ],
        {
          "drive-bad": () => googleError(403, "The user does not have sufficient permissions", "forbidden"),
          "drive-ok": [{ type: "user", role: "reader", emailAddress: "x@partner.example" }],
        }
      )
    );
    const { drives: result } = await listSharedDrives(t());
    assert.match(result[0].error ?? "", /sufficient permissions/);
    assert.equal(result[1].externalMembers.length, 1);
  });

  it("follows a long member list across pages", async () => {
    google.reset((call) => {
      const p = call.url.pathname;
      if (p === DOMAINS_PATH) return oneDomain();
      if (p === "/drive/v3/drives") return json({ drives: [{ id: "drive-x", name: "X" }] });
      if (p.endsWith("/permissions")) {
        return call.url.searchParams.get("pageToken")
          ? json({ permissions: [{ type: "user", role: "reader", emailAddress: "late@partner.example" }] })
          : json({
              permissions: [{ type: "user", role: "reader", emailAddress: "a@example.com" }],
              nextPageToken: "m2",
            });
      }
      return undefined;
    });
    const [drive] = (await listSharedDrives(t())).drives;
    assert.equal(drive.memberCount, 2);
    assert.deepEqual(drive.externalMembers.map((m) => m.target), ["late@partner.example"]);
  });

  it("refuses when the tenant's domains can't be told", async () => {
    google.reset((call) =>
      call.url.pathname === DOMAINS_PATH ? json({ domains: [] }) : undefined
    );
    await assert.rejects(listSharedDrives(t()), /No verified domains/);
    assert.equal(google.callsTo("/drive/v3/drives").length, 0);
  });
});

describe("listExternallySharedDriveFiles", () => {
  let n = 0;
  const t = () => ({ ...tenant, id: `drive-files-test-${++n}` });
  beforeEach(() => google.reset(() => undefined));

  const inherited = { permissionDetails: [{ inherited: true }] };
  const own = { permissionDetails: [{ inherited: false }] };

  /** One drive's files and each file's permissions; `readableBy` limits who can list it. */
  const driveWith = (
    files: unknown[],
    permissions: Record<string, unknown[]>,
    opts: { readableBy?: string[]; nextPageToken?: string } = {}
  ): Handler => (call) => {
    const p = call.url.pathname;
    if (p === DOMAINS_PATH) return oneDomain();
    if (p === "/drive/v3/files") {
      if (opts.readableBy && !opts.readableBy.includes(call.subject ?? "")) {
        return googleError(404, "Shared drive not found: drive-x", "notFound");
      }
      return json({ files, nextPageToken: opts.nextPageToken });
    }
    const perms = p.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/);
    if (perms) return json({ permissions: permissions[perms[1]] ?? [] });
    return undefined;
  };
  const scan = (overrides: Partial<Parameters<typeof listExternallySharedDriveFiles>[1]> = {}) =>
    listExternallySharedDriveFiles(t(), {
      driveId: "drive-x",
      asUsers: ["lead@example.com"],
      ...overrides,
    });

  it("reports files shared outside on top of the drive's membership", async () => {
    google.reset(
      driveWith(
        [
          { id: "f-plain", name: "Plain", mimeType: "text/plain", hasAugmentedPermissions: false },
          { id: "f-link", name: "Price list", mimeType: "application/pdf", webViewLink: "https://drive.example/f-link", hasAugmentedPermissions: true },
          { id: "f-person", name: "Contract", mimeType: "application/pdf", hasAugmentedPermissions: true },
          { id: "f-internal", name: "Internal", mimeType: "text/plain", hasAugmentedPermissions: true },
        ],
        {
          "f-link": [{ type: "anyone", role: "reader", allowFileDiscovery: false, ...own }],
          "f-person": [
            { type: "user", role: "writer", emailAddress: "counsel@lawfirm.example", ...own },
            { type: "user", role: "reader", emailAddress: "agency@partner.example", ...inherited },
          ],
          "f-internal": [{ type: "user", role: "writer", emailAddress: "colleague@example.com", ...own }],
        }
      )
    );
    const result = await scan();
    assert.equal(result.driveId, "drive-x");
    assert.equal(result.user, "lead@example.com");
    assert.equal(result.scannedFiles, 4);
    assert.equal(result.nextPageToken, null);
    assert.deepEqual(result.files, [
      {
        id: "f-person",
        name: "Contract",
        webViewLink: null,
        mimeType: "application/pdf",
        ownedByMe: false,
        externalCount: 1,
        external: [{ type: "user", role: "writer", target: "counsel@lawfirm.example" }],
      },
      {
        id: "f-link",
        name: "Price list",
        webViewLink: "https://drive.example/f-link",
        mimeType: "application/pdf",
        ownedByMe: false,
        externalCount: 1,
        external: [{ type: "anyone", role: "reader", target: "*", allowFileDiscovery: false }],
      },
    ]);
  });

  it("does not repeat the drive's own external members against every file", async () => {
    google.reset(
      driveWith([{ id: "f1", name: "Doc", hasAugmentedPermissions: true }], {
        f1: [{ type: "user", role: "reader", emailAddress: "agency@partner.example", ...inherited }],
      })
    );
    assert.deepEqual((await scan()).files, []);
  });

  it("looks up permissions only for files that have their own", async () => {
    google.reset(
      driveWith(
        [
          { id: "f1", name: "A", hasAugmentedPermissions: false },
          { id: "f2", name: "B", hasAugmentedPermissions: false },
          { id: "f3", name: "C", hasAugmentedPermissions: true },
        ],
        { f3: [] }
      )
    );
    await scan();
    assert.deepEqual(
      google.callsTo("/permissions").map((c) => c.url.pathname),
      ["/drive/v3/files/f3/permissions"]
    );
  });

  it("lists the drive as a member, with the metadata scope, and only reads", async () => {
    google.reset(driveWith([{ id: "f1", name: "A", hasAugmentedPermissions: true }], { f1: [] }));
    await scan();
    const listing = google.callsTo("/drive/v3/files")[0];
    assert.equal(listing.url.searchParams.get("corpora"), "drive");
    assert.equal(listing.url.searchParams.get("driveId"), "drive-x");
    assert.equal(listing.url.searchParams.get("includeItemsFromAllDrives"), "true");
    assert.equal(listing.url.searchParams.get("supportsAllDrives"), "true");
    for (const call of google.calls.filter((c) => c.url.pathname.startsWith("/drive/"))) {
      assert.equal(call.method, "GET");
      assert.equal(call.subject, "lead@example.com");
      assert.deepEqual(call.scopes, [DRIVE_METADATA]);
    }
  });

  it("falls back to the next member when the first can't read the drive", async () => {
    google.reset(driveWith([], {}, { readableBy: ["second@example.com"] }));
    const result = await scan({ asUsers: ["first@example.com", "second@example.com"] });
    assert.equal(result.user, "second@example.com");
  });

  it("fails with Google's reason when no member can read it", async () => {
    google.reset(driveWith([], {}, { readableBy: [] }));
    await assert.rejects(scan({ asUsers: ["first@example.com", "second@example.com"] }), /not found/i);
  });

  it("hands back a token to continue, and continues as the same member", async () => {
    google.reset(driveWith([{ id: "f1", name: "A", hasAugmentedPermissions: false }], {}, { nextPageToken: "more" }));
    // One page is under the per-call cap, so the scan keeps going until it is told there is no more.
    let pages = 0;
    google.reset((call) => {
      const p = call.url.pathname;
      if (p === DOMAINS_PATH) return oneDomain();
      if (p === "/drive/v3/files") {
        pages++;
        return json({
          files: Array.from({ length: 100 }, (_, i) => ({ id: `f${pages}-${i}`, name: "x", hasAugmentedPermissions: false })),
          nextPageToken: `page-${pages + 1}`,
        });
      }
      return undefined;
    });
    const result = await scan();
    assert.equal(result.scannedFiles, 1000, "stops at the per-call cap");
    assert.equal(result.truncated, true);
    assert.equal(result.nextPageToken, "page-11");
    await assert.rejects(
      scan({ pageToken: "page-11", asUsers: ["a@example.com", "b@example.com"] }),
      /one user it started as/
    );
  });

  it("never impersonates someone outside the organisation", async () => {
    google.reset(driveWith([], {}));
    await assert.rejects(scan({ asUsers: ["agency@partner.example"] }), /not in one of this tenant's domains/);
    assert.equal(google.callsTo("/drive/v3/files").length, 0);
  });

  it("rejects a malformed drive id or an empty member list before calling Drive", async () => {
    google.reset(driveWith([], {}));
    await assert.rejects(scan({ driveId: "../etc" }), /malformed/);
    await assert.rejects(scan({ asUsers: [] }), /No internal member/);
    assert.equal(google.callsTo("/drive/v3/files").length, 0);
  });

  it("skips a file whose permissions can't be read instead of failing the drive", async () => {
    google.reset((call) => {
      const p = call.url.pathname;
      if (p === DOMAINS_PATH) return oneDomain();
      if (p === "/drive/v3/files") {
        return json({
          files: [
            { id: "f-locked", name: "Locked", hasAugmentedPermissions: true },
            { id: "f-open", name: "Open", hasAugmentedPermissions: true },
          ],
        });
      }
      if (p === "/drive/v3/files/f-locked/permissions") {
        return googleError(403, "Insufficient permissions for this file", "forbidden");
      }
      if (p === "/drive/v3/files/f-open/permissions") {
        return json({ permissions: [{ type: "anyone", role: "reader", ...own }] });
      }
      return undefined;
    });
    assert.deepEqual((await scan()).files.map((f) => f.id), ["f-open"]);
  });
});
