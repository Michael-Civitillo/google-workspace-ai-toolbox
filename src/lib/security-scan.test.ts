/**
 * The Security Check scan, run against a stand-in for Google.
 *
 * The real function is called with a real (throwaway) service-account key; only
 * the network is replaced. That exercises what unit tests of the rules cannot:
 * which endpoints are called, as whom and with which scope, how a page is put
 * together, and what happens when one account's calls fail.
 *
 * The stand-in is installed as `window.fetch` because that is the one hook the
 * Google HTTP client (gaxios) offers without changing production code: it uses
 * `window.fetch` when a `window` exists and its own bundled fetch otherwise.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { isAbortError, scanSecurityPage } from "./admin-sdk";
import type { Tenant } from "./tenant-types";

const ADMIN = "admin@example.com";
const BASIC_SETTINGS = "https://www.googleapis.com/auth/gmail.settings.basic";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12);
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();
const NEVER = "1970-01-01T00:00:00.000Z";
const DOMAINS = new Set(["example.com"]);

interface Call {
  method: string;
  url: URL;
  /** Who the access token on this request was minted for. */
  subject: string | null;
  /** The scopes that token was minted with. */
  scopes: string[];
}

type Handler = (call: Call) => Response | Promise<Response> | undefined;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A Google-shaped error body. */
const googleError = (status: number, message: string, reason: string) =>
  json({ error: { code: status, message, errors: [{ message, reason }] } }, status);

class FakeGoogle {
  calls: Call[] = [];
  /** Token grants seen: who was impersonated, with which scopes. */
  grants: Array<{ subject: string; scopes: string[] }> = [];
  private tokens = new Map<string, { subject: string; scopes: string[] }>();
  handler: Handler = () => undefined;

  reset(handler: Handler): void {
    this.calls = [];
    this.grants = [];
    this.handler = handler;
  }

  fetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (init.signal?.aborted) {
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    }

    if (url.host === "oauth2.googleapis.com" || url.pathname.endsWith("/token")) {
      const assertion = new URLSearchParams(String(init.body)).get("assertion") ?? "";
      const claims = JSON.parse(
        Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString("utf-8")
      ) as { sub: string; scope: string };
      const grant = { subject: claims.sub, scopes: claims.scope.split(" ").sort() };
      this.grants.push(grant);
      const token = `token-${this.tokens.size + 1}`;
      this.tokens.set(token, grant);
      return json({ access_token: token, expires_in: 3600, token_type: "Bearer" });
    }

    const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /i, "");
    const grant = bearer ? this.tokens.get(bearer) : undefined;
    const call: Call = {
      method,
      url,
      subject: grant?.subject ?? null,
      scopes: grant?.scopes ?? [],
    };
    this.calls.push(call);
    const response = await this.handler(call);
    if (!response) {
      return googleError(404, `no fake for ${method} ${url.pathname}`, "notFound");
    }
    return response;
  };

  callsTo(pathSuffix: string): Call[] {
    return this.calls.filter((c) => c.url.pathname.endsWith(pathSuffix));
  }
}

const google = new FakeGoogle();
let tmpDir: string;
let tenant: Tenant;

before(() => {
  (globalThis as unknown as { window: unknown }).window = { fetch: google.fetch };
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "security-scan-test-"));
  const keyFile = path.join(tmpDir, "key.json");
  fs.writeFileSync(
    keyFile,
    JSON.stringify({
      type: "service_account",
      client_email: "scanner@test-project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    })
  );
  tenant = {
    id: "t1",
    name: "Test",
    color: "blue",
    credentialsFile: keyFile,
    adminEmail: ADMIN,
  };
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete (globalThis as unknown as { window?: unknown }).window;
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
      },
      {
        user: "bob@example.com",
        name: "bob",
        kind: "filter",
        target: "drop@evil.net",
        detail: "Filter on from:bank@example.net",
        hidesOriginal: false,
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
