// A made-up tenant for the end-to-end run, and the answers a correct Security
// Check must give for it. The expectations are worked out here by walking the
// accounts one at a time in plain code, independently of the app's own rules.
const DAY = 86_400_000;
export const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
const NEVER = "1970-01-01T00:00:00.000Z";
export const DOMAINS = ["example.com", "example.org"];
// A domain alias of example.com: part of the organisation, not a separate domain.
export const ALIASES = ["example.net"];
export const ADMIN = "admin@example.com";

const APPS = {
  chat: { clientId: "1001-chat.apps.googleusercontent.com", displayText: "TeamChat",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar"] },
  merge: { clientId: "1002-merge.apps.googleusercontent.com", displayText: "Mail Merge Pro",
    scopes: ["https://mail.google.com/", "https://www.googleapis.com/auth/spreadsheets"] },
  notes: { clientId: "1003-notes.apps.googleusercontent.com", displayText: "QuickNotes",
    scopes: ["openid", "profile"] },
  backup: { clientId: "1004-backup.apps.googleusercontent.com", displayText: "CloudBackup",
    scopes: ["https://www.googleapis.com/auth/drive"], anonymous: true },
};

function makeUser(i) {
  const email = `user${String(i).padStart(3, "0")}@example.com`;
  const u = {
    primaryEmail: email,
    name: { fullName: `User ${i}` },
    orgUnitPath: i % 4 === 0 ? "/Sales" : "/",
    isAdmin: false,
    isDelegatedAdmin: i === 2,
    suspended: i % 10 === 0,
    archived: i === 55,
    isEnrolledIn2Sv: i % 7 !== 0,
    isEnforcedIn2Sv: false,
    lastLoginTime: daysAgo(1 + (i % 9)),
    creationTime: daysAgo(700 + i),
    isMailboxSetup: i % 17 !== 0,
  };
  if (i % 11 === 0) u.lastLoginTime = daysAgo(120);
  if (i % 23 === 0) u.lastLoginTime = daysAgo(400);
  if (i % 29 === 0) { u.lastLoginTime = NEVER; u.creationTime = daysAgo(500); }
  if (i === 3) { u.lastLoginTime = NEVER; u.creationTime = daysAgo(3); }

  // Directory profile, for signatures: not everyone has a job title or a phone.
  if (i % 3 !== 0) u.organizations = [{ title: `Role ${i}`, department: i % 4 === 0 ? "Sales" : "Operations", primary: true }];
  if (i % 2 === 0) u.phones = [{ type: "work", value: `+44 20 7946 ${String(i).padStart(4, "0")}` }];

  const box = { forwarding: { enabled: false }, filters: [], tokens: [] };
  if (i === 1) box.signature = "<div>Sent from my <b>phone</b></div>";
  if (i === 5) box.forwarding = { enabled: true, emailAddress: "user005.private@personal.example", disposition: "trash" };
  if (i === 12) box.forwarding = { enabled: true, emailAddress: "team@example.org", disposition: "leaveInInbox" };
  if (i === 14) box.forwarding = { enabled: true, emailAddress: "user014@example.net", disposition: "leaveInInbox" };
  if (i === 33) box.filters = [
    { id: "a", criteria: { from: "bank@example.net" }, action: { forward: "collector@evil.example" } },
    { id: "b", criteria: { subject: "standup" }, action: { addLabelIds: ["Label_1"] } },
  ];
  if (i === 60) box.forwarding = { enabled: true, emailAddress: "should-never-be-read@evil.example", disposition: "trash" };
  if (i === 77) {
    box.forwarding = { enabled: true, emailAddress: "user077@outlook.example", disposition: "leaveInInbox" };
    box.filters = [{ id: "c", criteria: {}, action: { forward: "everything@evil.example" } }];
  }
  if (i % 2 === 0) box.tokens.push(APPS.chat);
  if (i % 9 === 0) box.tokens.push(APPS.merge);
  if (i % 5 === 0) box.tokens.push(APPS.notes);
  if (i === 4 || i === 8) box.tokens.push(APPS.backup);
  if (i === 41) box.gmailError = { status: 400, message: "Mail service not enabled", reason: "failedPrecondition" };
  if (i === 42) box.tokensError = { status: 403, message: "Not Authorized to access this resource/api", reason: "forbidden" };
  return { user: u, box };
}

export function buildTenant(count = 130) {
  const entries = [
    {
      user: {
        primaryEmail: ADMIN, name: { fullName: "Avery Admin" }, orgUnitPath: "/",
        isAdmin: true, isDelegatedAdmin: false, suspended: false, archived: false,
        isEnrolledIn2Sv: false, isEnforcedIn2Sv: false,
        lastLoginTime: daysAgo(0), creationTime: daysAgo(2000), isMailboxSetup: true,
      },
      box: { forwarding: { enabled: false }, filters: [], tokens: [APPS.chat] },
    },
  ];
  for (let i = 1; i <= count; i++) entries.push(makeUser(i));
  // The Directory API lists by email.
  entries.sort((a, b) => a.user.primaryEmail.localeCompare(b.user.primaryEmail));
  return entries;
}

/** What the page should show once the whole tenant has been scanned. */
export function expected(entries) {
  const isExternal = (addr) => ![...DOMAINS, ...ALIASES].includes(addr.split("@")[1]);
  const out = {
    accounts: entries.length, active: 0, skipped: 0,
    noTwoStep: [], adminsNoTwoStep: 0,
    inactive30: [], inactive90: [], inactive180: [], inactive365: [],
    forwardingMailboxes: new Set(), forwardingRules: 0, hiding: 0, internalForwards: 0,
    withoutMailbox: 0, mailboxErrors: [], appErrors: [],
    apps: new Map(),
  };
  for (const { user: u, box } of entries) {
    if (u.suspended || u.archived) { out.skipped++; continue; }
    out.active++;
    if (!u.isEnrolledIn2Sv) {
      out.noTwoStep.push(u.primaryEmail);
      if (u.isAdmin || u.isDelegatedAdmin) out.adminsNoTwoStep++;
    }
    const never = u.lastLoginTime === NEVER;
    const since = Date.parse(never ? u.creationTime : u.lastLoginTime);
    const idle = Math.floor((NOW - since) / DAY);
    for (const t of [30, 90, 180, 365]) if (idle >= t) out[`inactive${t}`].push(u.primaryEmail);

    if (!u.isMailboxSetup) out.withoutMailbox++;
    else if (box.gmailError) out.mailboxErrors.push(u.primaryEmail);
    else {
      if (box.forwarding.enabled) {
        if (isExternal(box.forwarding.emailAddress)) {
          out.forwardingMailboxes.add(u.primaryEmail); out.forwardingRules++;
          if (["trash", "archive"].includes(box.forwarding.disposition)) out.hiding++;
        } else out.internalForwards++;
      }
      for (const f of box.filters) {
        if (!f.action.forward) continue;
        if (isExternal(f.action.forward)) { out.forwardingMailboxes.add(u.primaryEmail); out.forwardingRules++; }
        else out.internalForwards++;
      }
    }
    if (box.tokensError) out.appErrors.push(u.primaryEmail);
    else for (const t of box.tokens) {
      if (!out.apps.has(t.displayText)) out.apps.set(t.displayText, new Set());
      out.apps.get(t.displayText).add(u.primaryEmail);
    }
  }
  return out;
}

// --- domain-wide delegation, as the admin log would record it -----------------
export const OWN_CLIENT_ID = "104857600000000000001";
export const BACKUP_CLIENT_ID = "112233445566778899001";
export const SCHEDULER_CLIENT_ID = "scheduler-tool.apps.googleusercontent.com";
// What Open Admin itself asks for (copied from src/lib/preflight.ts for this run).
const USED_SCOPES = ["https://www.googleapis.com/auth/admin.directory.user", "https://www.googleapis.com/auth/admin.directory.user.security", "https://www.googleapis.com/auth/admin.directory.domain.readonly", "https://www.googleapis.com/auth/admin.directory.group", "https://www.googleapis.com/auth/admin.reports.audit.readonly", "https://www.googleapis.com/auth/admin.datatransfer", "https://www.googleapis.com/auth/drive.metadata.readonly", "https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/gmail.settings.sharing", "https://www.googleapis.com/auth/gmail.settings.basic", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.insert", "https://www.googleapis.com/auth/gmail.labels", "https://www.googleapis.com/auth/calendar"];
const EXTRA_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const logItem = (days, actor, name, params) => ({
  id: { time: daysAgo(days), applicationName: "admin" },
  actor: { email: actor },
  events: [{ type: "DOMAIN_SETTINGS", name, parameters: params }],
});

export function delegationLog() {
  return {
    AUTHORIZE_API_CLIENT_ACCESS: [
      logItem(20, ADMIN, "AUTHORIZE_API_CLIENT_ACCESS", [
        { name: "API_CLIENT_NAME", value: BACKUP_CLIENT_ID },
        { name: "API_SCOPES", value: "https://mail.google.com/,https://www.googleapis.com/auth/drive" },
        { name: "DOMAIN_NAME", value: "example.com" },
      ]),
      logItem(60, ADMIN, "AUTHORIZE_API_CLIENT_ACCESS", [
        { name: "API_CLIENT_NAME", value: OWN_CLIENT_ID },
        { name: "API_SCOPES", value: [...USED_SCOPES, EXTRA_SCOPE].join(",") },
      ]),
      logItem(100, "user002@example.com", "AUTHORIZE_API_CLIENT_ACCESS", [
        { name: "API_CLIENT_NAME", value: SCHEDULER_CLIENT_ID },
        { name: "API_SCOPES", multiValue: ["https://www.googleapis.com/auth/calendar"] },
      ]),
    ],
    REMOVE_API_CLIENT_ACCESS: [
      logItem(40, ADMIN, "REMOVE_API_CLIENT_ACCESS", [
        { name: "API_CLIENT_NAME", value: SCHEDULER_CLIENT_ID },
      ]),
    ],
  };
}

// --- public DNS, as the email authentication check would see it ----------------
export const DNS_TXT = {
  "example.com": ["google-site-verification=abc123", "v=spf1 include:_spf.google.com ~all"],
  "google._domainkey.example.com": ["v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsamplekeyonly"],
  "_dmarc.example.com": ["v=DMARC1; p=none; rua=mailto:dmarc@example.com"],
  // example.org publishes nothing useful.
  "example.org": ["google-site-verification=def456"],
};

// --- what this tenant has (and hasn't) authorised for Open Admin's own key ------
// The delegation log above says it was granted gmail.modify on top of what it uses.
export const NOT_AUTHORISED = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/admin.directory.rolemanagement",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/ediscovery",
];

/** Change the tenant between scans, for the "new since last scan" checks. */
export function addSomethingNew(entries) {
  const target = entries.find((e) => e.user.primaryEmail === "user052@example.com");
  target.box.forwarding = { enabled: true, emailAddress: "user052.home@personal.example", disposition: "leaveInInbox" };
  target.box.tokens.push({
    clientId: "1005-shadowsync.apps.googleusercontent.com",
    displayText: "ShadowSync",
    scopes: ["https://mail.google.com/"],
  });
}

// --- shared drives ---------------------------------------------------------------
const own = { permissionDetails: [{ inherited: false }] };
const inherited = { permissionDetails: [{ inherited: true }] };
export const SHARED_DRIVES = [
  {
    id: "0AEsalesDrive0001", name: "Sales",
    members: [
      { type: "user", role: "organizer", emailAddress: "user001@example.com" },
      { type: "user", role: "writer", emailAddress: "agency@partner.example" },
      { type: "group", role: "reader", emailAddress: "everyone@example.com" },
    ],
    files: [
      { id: "file-pricelist", name: "Price list", mimeType: "application/pdf", webViewLink: "https://drive.google.com/file/d/file-pricelist/view", hasAugmentedPermissions: true,
        permissions: [{ type: "anyone", role: "reader", allowFileDiscovery: false, ...own }] },
      { id: "file-contract", name: "Contract", mimeType: "application/pdf", webViewLink: "https://drive.google.com/file/d/file-contract/view", hasAugmentedPermissions: true,
        permissions: [
          { type: "user", role: "writer", emailAddress: "counsel@lawfirm.example", ...own },
          { type: "user", role: "writer", emailAddress: "agency@partner.example", ...inherited },
        ] },
      { id: "file-notes", name: "Notes", mimeType: "text/plain", hasAugmentedPermissions: false, permissions: [] },
    ],
  },
  {
    id: "0AEhrDrive00000002", name: "HR",
    members: [{ type: "user", role: "organizer", emailAddress: "user002@example.com" }],
    files: [{ id: "file-handbook", name: "Handbook", mimeType: "application/pdf", hasAugmentedPermissions: false, permissions: [] }],
  },
  {
    id: "0AEprojDrive000003", name: "Projects",
    members: [{ type: "group", role: "organizer", emailAddress: "project-leads@example.com" }],
    files: [{ id: "file-secret", name: "Unreachable", mimeType: "text/plain", hasAugmentedPermissions: true, permissions: [{ type: "anyone", role: "reader", ...own }] }],
  },
];


// --- Licences ---------------------------------------------------------------
export const CUSTOMER_ID = "C0e2etest";
export const SKUS = {
  standard: { productId: "Google-Apps", productName: "Google Workspace", skuId: "1010020028", skuName: "Google Workspace Business Standard" },
  plus: { productId: "Google-Apps", productName: "Google Workspace", skuId: "1010020025", skuName: "Google Workspace Business Plus" },
  archived: { productId: "101034", productName: "Google Workspace Archived User", skuId: "1010340006", skuName: "Google Workspace Business Standard - Archived User" },
  voice: { productId: "101033", productName: "Google Voice", skuId: "1010330004", skuName: "Google Voice Standard" },
};
/** Who holds which licence, as [user, sku] pairs in directory order. */
export function buildLicenses(entries) {
  const out = [];
  for (const { user: u } of entries) {
    const n = Number(/user(\d+)@/.exec(u.primaryEmail)?.[1] ?? 0);
    if (u.archived) { out.push([u.primaryEmail, SKUS.archived]); continue; }
    // An account with no mailbox has no Workspace licence.
    if (u.isMailboxSetup !== false) out.push([u.primaryEmail, n % 4 === 0 ? SKUS.plus : SKUS.standard]);
    if (n % 20 === 0 && n > 0) out.push([u.primaryEmail, SKUS.voice]);
  }
  return out;
}
