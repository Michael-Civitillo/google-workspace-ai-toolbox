import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyScope,
  compareApps,
  delegationNeedsReview,
  describeFilterCriteria,
  findingKey,
  forwardingFindings,
  inactiveFinding,
  isExternalAddress,
  isInactiveAt,
  mergeAppGrants,
  parseScopeList,
  parseSignInTime,
  parseSnapshot,
  snapshotKeys,
  summariseAccess,
  summariseDelegation,
  twoStepFinding,
  type AppGrant,
  type DelegationEvent,
  type DirectoryAccount,
} from "./security-check";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12);
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();
const NEVER = "1970-01-01T00:00:00.000Z";

function account(overrides: Partial<DirectoryAccount> = {}): DirectoryAccount {
  return {
    primaryEmail: "sam@example.com",
    fullName: "Sam Example",
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
    ...overrides,
  };
}

const DOMAINS = new Set(["example.com", "example.org"]);
const OWNER = { primaryEmail: "sam@example.com", fullName: "Sam Example" };

describe("parseSignInTime", () => {
  it("reads a real timestamp", () => {
    assert.equal(parseSignInTime("2026-11-01T08:00:00.000Z"), Date.UTC(2026, 10, 1, 8));
  });

  it("treats Google's epoch sentinel as never", () => {
    assert.equal(parseSignInTime(NEVER), null);
  });

  it("treats a missing or unparseable value as never", () => {
    assert.equal(parseSignInTime(null), null);
    assert.equal(parseSignInTime(undefined), null);
    assert.equal(parseSignInTime(""), null);
    assert.equal(parseSignInTime("not a date"), null);
  });
});

describe("twoStepFinding", () => {
  it("passes an enrolled account", () => {
    assert.equal(twoStepFinding(account()), null);
  });

  it("reports an active account that is not enrolled", () => {
    assert.deepEqual(twoStepFinding(account({ enrolledIn2Sv: false })), {
      user: "sam@example.com",
      name: "Sam Example",
      orgUnitPath: "/",
      admin: false,
    });
  });

  it("marks super and delegated administrators", () => {
    assert.equal(twoStepFinding(account({ enrolledIn2Sv: false, isAdmin: true }))?.admin, true);
    assert.equal(
      twoStepFinding(account({ enrolledIn2Sv: false, isDelegatedAdmin: true }))?.admin,
      true
    );
  });

  it("ignores accounts nobody can sign in to", () => {
    assert.equal(twoStepFinding(account({ enrolledIn2Sv: false, suspended: true })), null);
    assert.equal(twoStepFinding(account({ enrolledIn2Sv: false, archived: true })), null);
  });

  it("still reports when 2SV is enforced but the account has not enrolled", () => {
    // Enforcement has a grace period; until enrolment the account has one factor.
    assert.notEqual(
      twoStepFinding(account({ enrolledIn2Sv: false, enforcedIn2Sv: true })),
      null
    );
  });
});

describe("inactiveFinding", () => {
  it("passes an account used recently", () => {
    assert.equal(inactiveFinding(account({ lastLoginTime: daysAgo(3) }), NOW), null);
  });

  it("reports the whole days since the last sign-in", () => {
    const finding = inactiveFinding(account({ lastLoginTime: daysAgo(200) }), NOW);
    assert.equal(finding?.idleDays, 200);
    assert.equal(finding?.lastLoginTime, daysAgo(200));
  });

  it("starts reporting at exactly the floor", () => {
    assert.equal(inactiveFinding(account({ lastLoginTime: daysAgo(29) }), NOW), null);
    assert.equal(inactiveFinding(account({ lastLoginTime: daysAgo(30) }), NOW)?.idleDays, 30);
  });

  it("measures a never-used account from its creation date", () => {
    const finding = inactiveFinding(
      account({ lastLoginTime: NEVER, creationTime: daysAgo(400) }),
      NOW
    );
    assert.equal(finding?.idleDays, 400);
    assert.equal(finding?.lastLoginTime, null);
  });

  it("leaves a brand-new account that hasn't been used yet alone", () => {
    assert.equal(
      inactiveFinding(account({ lastLoginTime: NEVER, creationTime: daysAgo(5) }), NOW),
      null
    );
  });

  it("reports an account with no dates at all rather than assuming it is fine", () => {
    const finding = inactiveFinding(
      account({ lastLoginTime: null, creationTime: null }),
      NOW
    );
    assert.equal(finding?.idleDays, null);
  });

  it("ignores suspended and archived accounts", () => {
    assert.equal(
      inactiveFinding(account({ lastLoginTime: daysAgo(500), suspended: true }), NOW),
      null
    );
    assert.equal(
      inactiveFinding(account({ lastLoginTime: daysAgo(500), archived: true }), NOW),
      null
    );
  });
});

describe("isInactiveAt", () => {
  const finding = (idleDays: number | null) => ({
    user: "u@example.com",
    name: "",
    orgUnitPath: "/",
    admin: false,
    lastLoginTime: null,
    creationTime: null,
    idleDays,
  });

  it("compares against the chosen threshold, inclusive", () => {
    assert.equal(isInactiveAt(finding(89), 90), false);
    assert.equal(isInactiveAt(finding(90), 90), true);
    assert.equal(isInactiveAt(finding(400), 365), true);
  });

  it("keeps an account of unknown age at every threshold", () => {
    assert.equal(isInactiveAt(finding(null), 365), true);
  });
});

describe("isExternalAddress", () => {
  it("accepts the tenant's own domains, whatever the case", () => {
    assert.equal(isExternalAddress("pat@example.com", DOMAINS), false);
    assert.equal(isExternalAddress("  Pat@EXAMPLE.org ", DOMAINS), false);
  });

  it("flags any other domain", () => {
    assert.equal(isExternalAddress("pat@gmail.com", DOMAINS), true);
  });

  it("is not fooled by a domain that merely contains ours", () => {
    assert.equal(isExternalAddress("pat@example.com.evil.net", DOMAINS), true);
    assert.equal(isExternalAddress("pat@notexample.com", DOMAINS), true);
    assert.equal(isExternalAddress("pat@mail.example.com", DOMAINS), true);
    assert.equal(isExternalAddress("example.com@evil.net", DOMAINS), true);
  });

  it("treats anything that isn't an address as external", () => {
    assert.equal(isExternalAddress("", DOMAINS), true);
    assert.equal(isExternalAddress("example.com", DOMAINS), true);
    assert.equal(isExternalAddress("@example.com", DOMAINS), true);
    assert.equal(isExternalAddress("pat@", DOMAINS), true);
  });
});

describe("describeFilterCriteria", () => {
  it("calls an unconditional filter what it is", () => {
    assert.equal(describeFilterCriteria(null), "all incoming mail");
    assert.equal(describeFilterCriteria({}), "all incoming mail");
  });

  it("writes criteria the way Gmail's search box would", () => {
    assert.equal(
      describeFilterCriteria({
        from: "billing@vendor.com",
        subject: "invoice",
        hasAttachment: true,
      }),
      "from:billing@vendor.com subject:invoice has:attachment"
    );
    assert.equal(
      describeFilterCriteria({ query: "password reset", negatedQuery: "newsletter" }),
      "password reset -{newsletter}"
    );
  });
});

describe("forwardingFindings", () => {
  it("finds nothing in a mailbox that forwards nothing", () => {
    assert.deepEqual(
      forwardingFindings(OWNER, { enabled: false, emailAddress: "x@gmail.com" }, [], DOMAINS),
      { external: [], internal: 0 }
    );
    assert.deepEqual(forwardingFindings(OWNER, null, [], DOMAINS), {
      external: [],
      internal: 0,
    });
  });

  it("reports mailbox-wide forwarding to an outside address", () => {
    const { external, internal } = forwardingFindings(
      OWNER,
      { enabled: true, emailAddress: "Sam.Personal@Gmail.com", disposition: "leaveInInbox" },
      [],
      DOMAINS
    );
    assert.equal(internal, 0);
    assert.deepEqual(external, [
      {
        user: "sam@example.com",
        name: "Sam Example",
        kind: "auto-forward",
        target: "sam.personal@gmail.com",
        detail: "Forwards all mail; keeps the original in the inbox",
        hidesOriginal: false,
        filterId: null,
      },
    ]);
  });

  it("flags forwarding that deletes or archives the original", () => {
    for (const disposition of ["trash", "archive"]) {
      const { external } = forwardingFindings(
        OWNER,
        { enabled: true, emailAddress: "drop@evil.net", disposition },
        [],
        DOMAINS
      );
      assert.equal(external[0].hidesOriginal, true, disposition);
    }
  });

  it("counts forwarding inside the organisation without reporting it", () => {
    assert.deepEqual(
      forwardingFindings(
        OWNER,
        { enabled: true, emailAddress: "team@example.org", disposition: "leaveInInbox" },
        [],
        DOMAINS
      ),
      { external: [], internal: 1 }
    );
  });

  it("ignores an enabled setting with no address", () => {
    assert.deepEqual(forwardingFindings(OWNER, { enabled: true }, [], DOMAINS), {
      external: [],
      internal: 0,
    });
  });

  it("reports filters that forward outside, and only those", () => {
    const { external, internal } = forwardingFindings(
      OWNER,
      { enabled: false },
      [
        { id: "1", criteria: { from: "bank@example.net" }, action: { forward: "x@evil.net" } },
        { id: "2", criteria: {}, action: { forward: "archive@example.com" } },
        { id: "3", criteria: { subject: "lunch" }, action: {} },
        { id: "4", criteria: null, action: { forward: "all@evil.net" } },
      ],
      DOMAINS
    );
    assert.equal(internal, 1);
    assert.deepEqual(
      external.map((f) => [f.kind, f.target, f.detail, f.filterId]),
      [
        ["filter", "x@evil.net", "Filter on from:bank@example.net", "1"],
        ["filter", "all@evil.net", "Filter on all incoming mail", "4"],
      ]
    );
  });

  it("reports the setting and the filters together", () => {
    const { external } = forwardingFindings(
      OWNER,
      { enabled: true, emailAddress: "a@evil.net", disposition: "markRead" },
      [{ action: { forward: "b@evil.net" } }],
      DOMAINS
    );
    assert.deepEqual(
      external.map((f) => f.kind),
      ["auto-forward", "filter"]
    );
  });
});

describe("classifyScope", () => {
  it("ranks full mail and full Drive access highest", () => {
    assert.deepEqual(classifyScope("https://mail.google.com/"), { level: "high", area: "Gmail" });
    assert.deepEqual(classifyScope("https://www.googleapis.com/auth/gmail.readonly"), {
      level: "high",
      area: "Gmail",
    });
    assert.deepEqual(classifyScope("https://www.googleapis.com/auth/drive"), {
      level: "high",
      area: "Drive",
    });
    assert.deepEqual(classifyScope("https://www.googleapis.com/auth/drive.readonly"), {
      level: "high",
      area: "Drive",
    });
  });

  it("ranks anything that reaches the admin console highest", () => {
    assert.deepEqual(
      classifyScope("https://www.googleapis.com/auth/admin.directory.user.readonly"),
      { level: "high", area: "Admin console" }
    );
  });

  it("does not mistake per-file Drive access for the whole of Drive", () => {
    assert.equal(classifyScope("https://www.googleapis.com/auth/drive.file").level, "low");
    assert.equal(classifyScope("https://www.googleapis.com/auth/drive.appdata").level, "low");
  });

  it("ranks sign-in scopes lowest", () => {
    for (const scope of [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/userinfo.email",
    ]) {
      assert.deepEqual(classifyScope(scope), { level: "low", area: "Sign-in" }, scope);
    }
  });

  it("puts single-product access in the middle", () => {
    assert.deepEqual(classifyScope("https://www.googleapis.com/auth/calendar.readonly"), {
      level: "medium",
      area: "Calendar",
    });
    assert.deepEqual(classifyScope("https://www.googleapis.com/auth/spreadsheets"), {
      level: "medium",
      area: "Docs, Sheets, Slides",
    });
    assert.deepEqual(classifyScope("https://www.googleapis.com/auth/gmail.send"), {
      level: "medium",
      area: "Send mail",
    });
  });

  it("does not call an unrecognised scope harmless", () => {
    assert.deepEqual(classifyScope("https://www.googleapis.com/auth/youtube.readonly"), {
      level: "medium",
      area: "Youtube",
    });
    assert.deepEqual(classifyScope("https://example.net/custom"), {
      level: "medium",
      area: "Other",
    });
  });

  it("ignores case, padding and a trailing slash", () => {
    assert.equal(classifyScope(" HTTPS://MAIL.GOOGLE.COM ").level, "high");
    assert.equal(classifyScope("https://www.googleapis.com/auth/drive/").level, "high");
  });

  it("recognises add-on scopes limited to the open item", () => {
    assert.equal(
      classifyScope("https://www.googleapis.com/auth/spreadsheets.currentonly").level,
      "low"
    );
    assert.equal(
      classifyScope("https://www.googleapis.com/auth/gmail.addons.current.message.readonly")
        .level,
      "low"
    );
  });
});

describe("summariseAccess", () => {
  it("takes the strongest scope as the app's level, strongest area first", () => {
    assert.deepEqual(
      summariseAccess([
        "openid",
        "https://www.googleapis.com/auth/calendar",
        "https://mail.google.com/",
        "https://www.googleapis.com/auth/gmail.labels",
      ]),
      {
        level: "high",
        areas: [
          { area: "Gmail", level: "high" },
          { area: "Calendar", level: "medium" },
          { area: "Gmail labels", level: "low" },
          { area: "Sign-in", level: "low" },
        ],
      }
    );
  });

  it("lists an area once, at its strongest", () => {
    assert.deepEqual(
      summariseAccess([
        "https://www.googleapis.com/auth/drive.metadata.readonly",
        "https://www.googleapis.com/auth/drive",
      ]).areas,
      [{ area: "Drive", level: "high" }]
    );
  });

  it("treats an app with no scopes as low", () => {
    assert.deepEqual(summariseAccess([]), { level: "low", areas: [] });
  });
});

function grant(overrides: Partial<AppGrant>): AppGrant {
  return {
    clientId: "1.apps.googleusercontent.com",
    name: "App",
    scopes: ["openid"],
    anonymous: false,
    nativeApp: false,
    users: ["a@example.com"],
    ...overrides,
  };
}

describe("mergeAppGrants", () => {
  it("adds up the same app across pages without double-counting people", () => {
    const total = new Map<string, AppGrant>();
    mergeAppGrants(total, [grant({ users: ["b@example.com", "a@example.com"] })]);
    mergeAppGrants(total, [
      grant({
        users: ["a@example.com", "c@example.com"],
        scopes: ["openid", "https://www.googleapis.com/auth/drive"],
        nativeApp: true,
      }),
    ]);
    assert.equal(total.size, 1);
    const merged = [...total.values()][0];
    assert.deepEqual(merged.users, ["a@example.com", "b@example.com", "c@example.com"]);
    assert.deepEqual(merged.scopes, ["https://www.googleapis.com/auth/drive", "openid"]);
    assert.equal(merged.nativeApp, true);
  });

  it("keeps two apps with the same name apart", () => {
    const total = new Map<string, AppGrant>();
    mergeAppGrants(total, [
      grant({ clientId: "real", name: "Slack" }),
      grant({ clientId: "imitation", name: "Slack", scopes: ["https://mail.google.com/"] }),
    ]);
    assert.equal(total.size, 2);
    assert.deepEqual(total.get("real")?.scopes, ["openid"]);
  });

  it("does not let later pages alter the page it was given", () => {
    const first = grant({ users: ["a@example.com"] });
    const total = new Map<string, AppGrant>();
    mergeAppGrants(total, [first]);
    mergeAppGrants(total, [grant({ users: ["z@example.com"] })]);
    assert.deepEqual(first.users, ["a@example.com"]);
  });
});

describe("compareApps", () => {
  it("orders by access, then by how many people, then by name", () => {
    const apps = [
      grant({ clientId: "1", name: "Sign-in only", scopes: ["openid"], users: ["a", "b", "c"] }),
      grant({ clientId: "2", name: "Zeta mail", scopes: ["https://mail.google.com/"] }),
      grant({
        clientId: "3",
        name: "Alpha mail",
        scopes: ["https://mail.google.com/"],
        users: ["a", "b"],
      }),
      grant({ clientId: "4", name: "Beta mail", scopes: ["https://mail.google.com/"] }),
      grant({
        clientId: "5",
        name: "Calendar tool",
        scopes: ["https://www.googleapis.com/auth/calendar"],
      }),
    ];
    assert.deepEqual(
      apps.sort(compareApps).map((a) => a.name),
      ["Alpha mail", "Beta mail", "Zeta mail", "Calendar tool", "Sign-in only"]
    );
  });
});

const GMAIL = "https://mail.google.com/";
const DRIVE = "https://www.googleapis.com/auth/drive";
const CALENDAR = "https://www.googleapis.com/auth/calendar";

describe("parseScopeList", () => {
  it("reads one scope", () => {
    assert.deepEqual(parseScopeList(GMAIL), [GMAIL]);
  });

  it("splits a single string on commas, spaces and new lines", () => {
    assert.deepEqual(parseScopeList(`${GMAIL},${DRIVE}`), [GMAIL, DRIVE]);
    assert.deepEqual(parseScopeList(`${GMAIL}, ${DRIVE}\n${CALENDAR}`), [GMAIL, DRIVE, CALENDAR]);
  });

  it("reads a list, including one whose items are themselves lists", () => {
    assert.deepEqual(parseScopeList([GMAIL, DRIVE]), [GMAIL, DRIVE]);
    assert.deepEqual(parseScopeList([`${GMAIL},${DRIVE}`, CALENDAR]), [GMAIL, DRIVE, CALENDAR]);
  });

  it("drops blanks and repeats", () => {
    assert.deepEqual(parseScopeList(` ${GMAIL} ,, ${GMAIL} `), [GMAIL]);
  });

  it("treats nothing as no scopes", () => {
    assert.deepEqual(parseScopeList(null), []);
    assert.deepEqual(parseScopeList(undefined), []);
    assert.deepEqual(parseScopeList(""), []);
    assert.deepEqual(parseScopeList([]), []);
  });
});

function change(overrides: Partial<DelegationEvent>): DelegationEvent {
  return {
    time: "2026-10-01T09:00:00.000Z",
    actor: "admin@example.com",
    kind: "authorize",
    clientId: "111",
    scopes: [CALENDAR],
    ...overrides,
  };
}

const NOT_OURS = { ownClientId: null, usedScopes: [] };

describe("summariseDelegation", () => {
  it("returns nothing for an empty log", () => {
    assert.deepEqual(summariseDelegation([], NOT_OURS), []);
  });

  it("reports a granted client with who granted it and when", () => {
    const [client] = summariseDelegation([change({ scopes: [DRIVE, GMAIL] })], NOT_OURS);
    assert.equal(client.clientId, "111");
    assert.equal(client.status, "authorized");
    assert.deepEqual(client.scopes, [GMAIL, DRIVE].sort());
    assert.equal(client.lastActor, "admin@example.com");
    assert.equal(client.lastChange, "2026-10-01T09:00:00.000Z");
    assert.equal(client.ownApp, false);
  });

  it("lets the most recent change decide, whatever order the log arrives in", () => {
    const removedLast = summariseDelegation(
      [
        change({ kind: "remove", time: "2026-10-05T00:00:00.000Z", scopes: [] }),
        change({ time: "2026-10-01T00:00:00.000Z" }),
      ],
      NOT_OURS
    );
    assert.equal(removedLast[0].status, "removed");
    assert.equal(removedLast[0].lastChange, "2026-10-05T00:00:00.000Z");

    const grantedAgain = summariseDelegation(
      [
        change({ time: "2026-10-01T00:00:00.000Z" }),
        change({ kind: "remove", time: "2026-10-05T00:00:00.000Z", scopes: [] }),
        change({ time: "2026-10-09T00:00:00.000Z", scopes: [GMAIL], actor: "other@example.com" }),
      ],
      NOT_OURS
    );
    assert.equal(grantedAgain[0].status, "authorized");
    assert.deepEqual(grantedAgain[0].scopes, [GMAIL]);
    assert.equal(grantedAgain[0].lastActor, "other@example.com");
    assert.equal(grantedAgain[0].history.length, 3);
    assert.deepEqual(
      grantedAgain[0].history.map((e) => e.time),
      ["2026-10-09T00:00:00.000Z", "2026-10-05T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]
    );
  });

  it("takes a client's scopes from its latest grant, not a union of old ones", () => {
    // Editing an entry in the Admin console replaces its scopes.
    const [client] = summariseDelegation(
      [
        change({ time: "2026-09-01T00:00:00.000Z", scopes: [GMAIL, DRIVE] }),
        change({ time: "2026-10-01T00:00:00.000Z", scopes: [CALENDAR] }),
      ],
      NOT_OURS
    );
    assert.deepEqual(client.scopes, [CALENDAR]);
  });

  it("keeps a removed client's last scopes, so the history still reads", () => {
    const [client] = summariseDelegation(
      [
        change({ time: "2026-09-01T00:00:00.000Z", scopes: [GMAIL] }),
        change({ kind: "remove", time: "2026-10-01T00:00:00.000Z", scopes: [] }),
      ],
      NOT_OURS
    );
    assert.equal(client.status, "removed");
    assert.deepEqual(client.scopes, [GMAIL]);
  });

  it("keeps clients apart and ignores entries with no client", () => {
    const clients = summariseDelegation(
      [change({ clientId: "111" }), change({ clientId: "222" }), change({ clientId: "  " })],
      NOT_OURS
    );
    assert.deepEqual(clients.map((c) => c.clientId).sort(), ["111", "222"]);
  });

  it("puts authorised clients first, widest access first, then most recent", () => {
    const clients = summariseDelegation(
      [
        change({ clientId: "calendar-old", time: "2026-08-01T00:00:00.000Z" }),
        change({ clientId: "calendar-new", time: "2026-10-01T00:00:00.000Z" }),
        change({ clientId: "mail", scopes: [GMAIL], time: "2026-07-01T00:00:00.000Z" }),
        change({ clientId: "gone", scopes: [GMAIL], time: "2026-06-01T00:00:00.000Z" }),
        change({ clientId: "gone", kind: "remove", scopes: [], time: "2026-11-01T00:00:00.000Z" }),
      ],
      NOT_OURS
    );
    assert.deepEqual(
      clients.map((c) => c.clientId),
      ["mail", "calendar-new", "calendar-old", "gone"]
    );
  });

  it("recognises Open Admin's own client and lists what it never uses", () => {
    const [client] = summariseDelegation(
      [change({ clientId: "999", scopes: [CALENDAR, GMAIL, "https://www.googleapis.com/auth/Drive/"] })],
      { ownClientId: " 999 ", usedScopes: [CALENDAR, DRIVE] }
    );
    assert.equal(client.ownApp, true);
    assert.deepEqual(client.unusedScopes, [GMAIL], "case and a trailing slash don't make a scope unused");
  });

  it("does not list unused scopes for anyone else's client, or a removed one", () => {
    const others = summariseDelegation([change({ clientId: "111", scopes: [GMAIL] })], {
      ownClientId: "999",
      usedScopes: [CALENDAR],
    });
    assert.deepEqual(others[0].unusedScopes, []);

    const removed = summariseDelegation(
      [
        change({ clientId: "999", scopes: [GMAIL], time: "2026-09-01T00:00:00.000Z" }),
        change({ clientId: "999", kind: "remove", scopes: [], time: "2026-10-01T00:00:00.000Z" }),
      ],
      { ownClientId: "999", usedScopes: [CALENDAR] }
    );
    assert.deepEqual(removed[0].unusedScopes, []);
  });
});

describe("delegationNeedsReview", () => {
  const one = (events: DelegationEvent[], ownClientId: string | null = null) =>
    summariseDelegation(events, { ownClientId, usedScopes: [CALENDAR] })[0];

  it("flags any other app that currently holds delegation", () => {
    assert.equal(delegationNeedsReview(one([change({ scopes: [CALENDAR] })])), true);
  });

  it("does not flag a client whose delegation was removed", () => {
    assert.equal(
      delegationNeedsReview(
        one([
          change({ time: "2026-09-01T00:00:00.000Z" }),
          change({ kind: "remove", scopes: [], time: "2026-10-01T00:00:00.000Z" }),
        ])
      ),
      false
    );
  });

  it("accepts Open Admin's own client when it holds only what it uses", () => {
    assert.equal(delegationNeedsReview(one([change({ scopes: [CALENDAR] })], "111")), false);
  });

  it("flags Open Admin's own client when it was granted more than it uses", () => {
    assert.equal(delegationNeedsReview(one([change({ scopes: [CALENDAR, GMAIL] })], "111")), true);
  });
});

describe("snapshotKeys", () => {
  const idle = (user: string, idleDays: number | null) => ({
    user,
    name: "",
    orgUnitPath: "/",
    admin: false,
    lastLoginTime: null,
    creationTime: null,
    idleDays,
  });

  it("is empty for a scan that found nothing", () => {
    assert.deepEqual(
      snapshotKeys({ twoStep: [], inactive: [], forwarding: [], apps: [], delegated: [] }),
      []
    );
  });

  it("gives an inactive account one key per threshold it has crossed", () => {
    const keys = snapshotKeys({
      twoStep: [],
      inactive: [idle("a@example.com", 95), idle("b@example.com", 400), idle("c@example.com", null)],
      forwarding: [],
      apps: [],
      delegated: [],
    });
    assert.deepEqual(keys.filter((k) => k.endsWith("|a@example.com")), [
      "idle30|a@example.com",
      "idle90|a@example.com",
    ]);
    assert.equal(keys.filter((k) => k.endsWith("|b@example.com")).length, 4);
    assert.equal(
      keys.filter((k) => k.endsWith("|c@example.com")).length,
      4,
      "an account of unknown age counts at every threshold"
    );
  });

  it("so an account drifting past a threshold is new there and nowhere else", () => {
    const before = new Set(
      snapshotKeys({ twoStep: [], inactive: [idle("a@example.com", 80)], forwarding: [], apps: [], delegated: [] })
    );
    const now = idle("a@example.com", 95);
    assert.equal(before.has(findingKey.inactive(now, 30)), true, "not new at 30 days");
    assert.equal(before.has(findingKey.inactive(now, 90)), false, "new at 90 days");
  });

  it("treats an app that gains broader access as new", () => {
    const narrow = grant({ clientId: "x", scopes: ["openid"] });
    const broad = grant({ clientId: "x", scopes: ["openid", GMAIL] });
    assert.notEqual(findingKey.app(narrow), findingKey.app(broad));
    assert.equal(
      findingKey.app(narrow),
      findingKey.app(grant({ clientId: "x", scopes: ["openid", "email"], users: ["z@example.com"] })),
      "more people or another sign-in scope is not a change in reach"
    );
  });

  it("treats every delegation change as new once", () => {
    const [first] = summariseDelegation([change({ time: "2026-10-01T00:00:00.000Z" })], NOT_OURS);
    const [regranted] = summariseDelegation(
      [change({ time: "2026-10-01T00:00:00.000Z" }), change({ time: "2026-11-01T00:00:00.000Z" })],
      NOT_OURS
    );
    assert.notEqual(findingKey.delegation(first), findingKey.delegation(regranted));
  });

  it("keeps two forwards from one mailbox apart", () => {
    const base = { user: "a@example.com", name: "", detail: "", hidesOriginal: false, filterId: null };
    const keys = snapshotKeys({
      twoStep: [],
      inactive: [],
      forwarding: [
        { ...base, kind: "auto-forward", target: "x@evil.net" },
        { ...base, kind: "filter", target: "x@evil.net" },
        { ...base, kind: "filter", target: "y@evil.net" },
      ],
      apps: [],
      delegated: [],
    });
    assert.equal(keys.length, 3);
  });

  it("returns each key once, in a stable order", () => {
    const f = { user: "a@example.com", name: "", orgUnitPath: "/", admin: false };
    const keys = snapshotKeys({ twoStep: [f, f], inactive: [], forwarding: [], apps: [], delegated: [] });
    assert.deepEqual(keys, ["2sv|a@example.com"]);
  });
});

describe("parseSnapshot", () => {
  const good = { completedAt: "2026-11-01T10:00:00.000Z", keys: ["2sv|a@example.com"], covered: ["twoStep", "apps"] };

  it("accepts a well-formed snapshot", () => {
    assert.deepEqual(parseSnapshot(good), good);
  });

  it("drops check names it doesn't know and tolerates none at all", () => {
    assert.deepEqual(parseSnapshot({ ...good, covered: ["apps", "made-up", 7] })?.covered, ["apps"]);
    assert.deepEqual(parseSnapshot({ ...good, covered: undefined })?.covered, []);
  });

  it("rejects anything that isn't a snapshot", () => {
    for (const bad of [
      null,
      "text",
      [],
      {},
      { ...good, completedAt: "yesterday" },
      { ...good, keys: "2sv|a" },
      { ...good, keys: [1, 2] },
      { ...good, keys: [""] },
      { ...good, keys: ["x".repeat(601)] },
    ]) {
      assert.equal(parseSnapshot(bad), null, JSON.stringify(bad)?.slice(0, 60));
    }
  });
});
