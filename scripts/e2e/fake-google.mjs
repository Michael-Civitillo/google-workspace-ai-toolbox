// A stand-in for Google's servers, for the end-to-end run.
//
// It is an HTTPS proxy: the app is started with HTTPS_PROXY pointing here and
// NODE_EXTRA_CA_CERTS trusting the throwaway CA made below, so its real Google
// client opens real TLS connections to "admin.googleapis.com" and friends and
// this process answers them. Nothing in the app is replaced or mocked.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import tls from "node:tls";
import dgram from "node:dgram";
import { addSomethingNew, ALIASES, buildLicenses, buildTenant, CUSTOMER_ID, SKUS, delegationLog, DNS_TXT, DOMAINS, NOT_AUTHORISED, SHARED_DRIVES } from "./dataset.mjs";

const dir = process.argv[2];
const port = Number(process.argv[3]);
fs.mkdirSync(dir, { recursive: true });

// --- throwaway CA and a certificate for the Google hosts -------------------
const ca = { key: path.join(dir, "ca.key"), crt: path.join(dir, "ca.pem") };
const leaf = { key: path.join(dir, "leaf.key"), csr: path.join(dir, "leaf.csr"), crt: path.join(dir, "leaf.pem"), ext: path.join(dir, "leaf.ext") };
const ssl = (...args) => execFileSync("openssl", args, { stdio: "ignore" });
ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=Fake Google test CA", "-keyout", ca.key, "-out", ca.crt);
ssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=googleapis.test", "-keyout", leaf.key, "-out", leaf.csr);
fs.writeFileSync(leaf.ext, "subjectAltName=DNS:*.googleapis.com,DNS:googleapis.com\n");
ssl("x509", "-req", "-in", leaf.csr, "-CA", ca.crt, "-CAkey", ca.key, "-CAcreateserial", "-days", "2", "-extfile", leaf.ext, "-out", leaf.crt);
const secureContext = tls.createSecureContext({ key: fs.readFileSync(leaf.key), cert: fs.readFileSync(leaf.crt) });

// --- state the driver can change and read ----------------------------------
let tenant = buildTenant();
let settings = { latencyMs: 0, failAllTokens: false, failDirectoryAfterPages: 0, failReports: false, noDelegation: false, groupDelayMs: 0, failSignOut: false, refuseLicensing: false, licensingApiOff: false, failVoice: false, licensePageSize: 500 };
const LICENSING_SCOPE = "https://www.googleapis.com/auth/apps.licensing";
let licenses = buildLicenses(tenant);
let release = { tag: "v0.0.1", html: "", status: 200 };
const releaseHits = [];
// Writes the app made, for the driver to read back.
let changes = [];
const freshGroups = () => new Map([
  ["all-staff@example.com", new Map([["user001@example.com", "OWNER"]])],
  ["sales@example.com", new Map()],
]);
let groups = freshGroups();
const findUser = (key) => {
  const k = String(key ?? "").toLowerCase();
  return tenant.find((e) => e.user.primaryEmail.toLowerCase() === k || (e.user.aliases ?? []).includes(k));
};
const tokens = new Map();
let tokenGrants = [];
let tokenRefusals = [];
let log = [];
let directoryPages = 0;

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const googleError = (res, status, message, reason) =>
  send(res, status, { error: { code: status, message, errors: [{ message, reason }] } });

async function handle(req, res) {
  const host = req.headers.host ?? "";
  const url = new URL(req.url, `https://${host}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf-8");

  if (host.startsWith("oauth2.googleapis.com") || url.pathname === "/token") {
    const assertion = new URLSearchParams(body).get("assertion") ?? "";
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString("utf-8"));
    const requested = claims.scope.split(" ");
    if (requested.some((scope) => NOT_AUTHORISED.includes(scope) || (settings.refuseLicensing && scope === LICENSING_SCOPE))) {
      tokenRefusals.push(requested);
      return send(res, 401, {
        error: "unauthorized_client",
        error_description: "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.",
      });
    }
    tokenGrants.push({ subject: claims.sub, scopes: requested });
    const token = `fake-${tokens.size + 1}`;
    tokens.set(token, { subject: claims.sub, scopes: claims.scope.split(" ").sort() });
    return send(res, 200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
  }

  const grant = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
  log.push({ method: req.method, host, path: url.pathname, subject: grant?.subject ?? null, scopes: grant?.scopes ?? [] });
  if (!grant) return googleError(res, 401, "Invalid Credentials", "authError");
  if (settings.latencyMs) await new Promise((r) => setTimeout(r, settings.latencyMs));

  const p = url.pathname;
  if (p === "/admin/directory/v1/customer/my_customer/domains") {
    return send(res, 200, { domains: DOMAINS.map((d, i) => ({
      domainName: d, isPrimary: i === 0, verified: true,
      domainAliases: i === 0 ? ALIASES.map((a) => ({ domainAliasName: a, parentDomainName: d, verified: true })) : undefined,
    })) });
  }
  // --- Drive: shared drives ---
  if (p === "/drive/v3/drives") {
    if (url.searchParams.get("useDomainAdminAccess") !== "true") return send(res, 200, { drives: [] });
    return send(res, 200, { drives: SHARED_DRIVES.map((d) => ({ id: d.id, name: d.name })) });
  }
  if (p === "/drive/v3/files") {
    const drive = SHARED_DRIVES.find((d) => d.id === url.searchParams.get("driveId"));
    if (!drive || url.searchParams.get("corpora") !== "drive") return send(res, 200, { files: [] });
    // Only a member can list a shared drive's files.
    if (!drive.members.some((m) => m.type === "user" && m.emailAddress === grant.subject)) {
      return googleError(res, 404, `Shared drive not found: ${drive.id}`, "notFound");
    }
    // A file listing doesn't carry who each file is shared with; that is a
    // second request per file, as it is with the real Drive.
    return send(res, 200, { files: drive.files.map((file) => ({ ...file, permissions: undefined })) });
  }
  const drivePerms = p.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/);
  if (drivePerms) {
    const drive = SHARED_DRIVES.find((d) => d.id === drivePerms[1]);
    if (drive) {
      if (url.searchParams.get("useDomainAdminAccess") !== "true") return googleError(res, 403, "The user does not have sufficient permissions for this file", "forbidden");
      return send(res, 200, { permissions: drive.members });
    }
    for (const d of SHARED_DRIVES) {
      const file = d.files.find((f) => f.id === drivePerms[1]);
      if (file) return send(res, 200, { permissions: file.permissions });
    }
    return googleError(res, 404, "File not found", "notFound");
  }
  if (p === "/admin/reports/v1/activity/users/all/applications/admin") {
    if (settings.failReports) return googleError(res, 403, "Not Authorized to access this resource/api", "forbidden");
    const items = settings.noDelegation ? [] : delegationLog()[url.searchParams.get("eventName")] ?? [];
    return send(res, 200, { items });
  }
  // --- Directory: creating and changing accounts ---
  if (p === "/admin/directory/v1/users" && req.method === "POST") {
    const b = JSON.parse(body || "{}");
    if (findUser(b.primaryEmail)) return googleError(res, 409, "Entity already exists.", "duplicate");
    const user = {
      primaryEmail: b.primaryEmail, name: { ...b.name, fullName: `${b.name?.givenName} ${b.name?.familyName}` },
      orgUnitPath: b.orgUnitPath ?? "/", isAdmin: false, isDelegatedAdmin: false, suspended: false, archived: false,
      isEnrolledIn2Sv: false, isEnforcedIn2Sv: false, changePasswordAtNextLogin: b.changePasswordAtNextLogin === true,
      lastLoginTime: "1970-01-01T00:00:00.000Z", creationTime: new Date().toISOString(), isMailboxSetup: false,
    };
    tenant.push({ user, box: { forwarding: { enabled: false }, filters: [], tokens: [] }, createdAt: Date.now() });
    changes.push({ kind: "create", subject: grant.subject, body: b });
    return send(res, 200, user);
  }
  const signOut = p.match(/^\/admin\/directory\/v1\/users\/([^/]+)\/signOut$/);
  if (signOut && req.method === "POST") {
    const entry = findUser(decodeURIComponent(signOut[1]));
    if (!entry) return googleError(res, 404, "Resource Not Found: userKey", "notFound");
    if (settings.failSignOut) return googleError(res, 403, "Not Authorized to access this resource/api", "forbidden");
    changes.push({ kind: "signOut", subject: grant.subject, user: entry.user.primaryEmail });
    res.writeHead(204); return res.end();
  }
  const oneUser = p.match(/^\/admin\/directory\/v1\/users\/([^/]+)$/);
  if (oneUser) {
    const entry = findUser(decodeURIComponent(oneUser[1]));
    if (!entry) return googleError(res, 404, "Resource Not Found: userKey", "notFound");
    if (req.method === "GET") return send(res, 200, { ...entry.user, customerId: CUSTOMER_ID });
    if (req.method === "PUT") {
      const b = JSON.parse(body || "{}");
      // The account takes every field sent except the password, which the
      // stand-in has no use for. The full request is kept for the driver.
      Object.assign(entry.user, { ...b, password: undefined });
      changes.push({ kind: "update", subject: grant.subject, user: entry.user.primaryEmail, body: b });
      return send(res, 200, entry.user);
    }
  }
  // --- Licences ---
  if (p.startsWith("/apps/licensing/v1/product/")) {
    if (settings.licensingApiOff) return googleError(res, 403, "Enterprise License Manager API has not been used in project 1234567890 before or it is disabled. Enable it by visiting the console then retry.", "accessNotConfigured");
    const list = p.match(/^\/apps\/licensing\/v1\/product\/([^/]+)\/users$/);
    if (list) {
      const productId = decodeURIComponent(list[1]);
      if (url.searchParams.get("customerId") !== CUSTOMER_ID) return googleError(res, 400, "Invalid customerId", "invalid");
      if (productId === "101033" && settings.failVoice) return googleError(res, 403, "Not Authorized to access this resource/api", "forbidden");
      if (!["Google-Apps", "101034", "101033"].includes(productId)) return googleError(res, 400, "Invalid productId", "invalid");
      const all = licenses.filter(([, sku]) => sku.productId === productId);
      const size = Math.min(Number(url.searchParams.get("maxResults") ?? 100), settings.licensePageSize);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      return send(res, 200, {
        items: all.slice(start, start + size).map(([userId, sku]) => ({ userId, ...sku })),
        nextPageToken: start + size < all.length ? String(start + size) : undefined,
      });
    }
    const one = p.match(/^\/apps\/licensing\/v1\/product\/([^/]+)\/sku\/([^/]+)\/user(?:\/([^/]+))?$/);
    if (one) {
      const [productId, skuId, userId] = [one[1], one[2], one[3]].map((x) => (x ? decodeURIComponent(x) : x));
      if (req.method === "POST" && !userId) {
        const b = JSON.parse(body || "{}");
        const known = Object.values(SKUS).find((k) => k.productId === productId && k.skuId === skuId);
        if (!known) return googleError(res, 400, "Invalid skuId", "invalid");
        if (!findUser(b.userId)) return googleError(res, 404, "User not found", "notFound");
        if (licenses.some(([u, sku]) => u === b.userId && sku.productId === productId)) return googleError(res, 412, "User already has a license for the specified product and SKU", "conditionNotMet");
        licenses.push([b.userId, known]);
        changes.push({ kind: "licenseAssign", subject: grant.subject, scopes: grant.scopes, user: b.userId, skuId });
        return send(res, 200, { userId: b.userId, ...known });
      }
      const held = licenses.find(([u, sku]) => u === userId && sku.productId === productId && sku.skuId === skuId);
      if (!held) return googleError(res, 404, "User does not have a license for specified sku and product", "notFound");
      if (req.method === "GET") return send(res, 200, { userId, ...held[1] });
      if (req.method === "DELETE") {
        licenses = licenses.filter((l) => l !== held);
        changes.push({ kind: "licenseRemove", subject: grant.subject, scopes: grant.scopes, user: userId, skuId });
        res.writeHead(204); return res.end();
      }
    }
  }
  // --- Directory: groups ---
  const groupMembers = p.match(/^\/admin\/directory\/v1\/groups\/([^/]+)\/members$/);
  if (groupMembers && req.method === "POST") {
    const name = decodeURIComponent(groupMembers[1]).toLowerCase();
    const group = groups.get(name);
    if (!group) return googleError(res, 404, "Resource Not Found: groupKey", "notFound");
    const b = JSON.parse(body || "{}");
    const member = String(b.email).toLowerCase();
    // A brand-new account can't be added to a group straight away.
    const entry = findUser(member);
    if (entry?.createdAt && Date.now() - entry.createdAt < settings.groupDelayMs) {
      changes.push({ kind: "groupAddTooSoon", group: name, member });
      return googleError(res, 404, "Resource Not Found: memberKey", "notFound");
    }
    if (group.has(member)) return googleError(res, 409, "Member already exists.", "duplicate");
    group.set(member, b.role ?? "MEMBER");
    changes.push({ kind: "groupAdd", subject: grant.subject, scopes: grant.scopes, group: name, member, role: b.role ?? "MEMBER" });
    return send(res, 200, { email: member, role: b.role ?? "MEMBER" });
  }
  const groupMember = p.match(/^\/admin\/directory\/v1\/groups\/([^/]+)\/members\/([^/]+)$/);
  if (groupMember) {
    const name = decodeURIComponent(groupMember[1]).toLowerCase();
    const member = decodeURIComponent(groupMember[2]).toLowerCase();
    const group = groups.get(name);
    if (!group) return googleError(res, 404, "Resource Not Found: groupKey", "notFound");
    if (!group.has(member)) return googleError(res, 404, "Resource Not Found: memberKey", "notFound");
    if (req.method === "GET") return send(res, 200, { email: member, role: group.get(member) });
    if (req.method === "PUT" || req.method === "PATCH") {
      const b = JSON.parse(body || "{}");
      changes.push({ kind: "groupRole", group: name, member, from: group.get(member), to: b.role });
      group.set(member, b.role);
      return send(res, 200, { email: member, role: b.role });
    }
    if (req.method === "DELETE") {
      group.delete(member);
      changes.push({ kind: "groupRemove", subject: grant.subject, group: name, member });
      res.writeHead(204); return res.end();
    }
  }
  const oneGroup = p.match(/^\/admin\/directory\/v1\/groups\/([^/]+)$/);
  if (oneGroup && req.method === "GET") {
    const name = decodeURIComponent(oneGroup[1]).toLowerCase();
    return groups.has(name) ? send(res, 200, { id: `id-${name}`, email: name }) : googleError(res, 404, "Resource Not Found: groupKey", "notFound");
  }
  // --- Calendar: sharing ---
  const acl = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/acl$/);
  if (acl && req.method === "POST") {
    const b = JSON.parse(body || "{}");
    changes.push({ kind: "calendarShare", subject: grant.subject, calendar: decodeURIComponent(acl[1]), role: b.role, with: b.scope?.value });
    return send(res, 200, { id: `user:${b.scope?.value}`, role: b.role, scope: b.scope });
  }
  if (p === "/admin/directory/v1/users") {
    directoryPages++;
    if (settings.failDirectoryAfterPages && directoryPages > settings.failDirectoryAfterPages) {
      return googleError(res, 403, "Not Authorized to access this resource/api", "forbidden");
    }
    const size = Number(url.searchParams.get("maxResults") ?? 100);
    const start = Number(url.searchParams.get("pageToken") ?? 0);
    const slice = tenant.slice(start, start + size);
    return send(res, 200, {
      users: slice.map((e) => e.user),
      nextPageToken: start + size < tenant.length ? String(start + size) : undefined,
    });
  }
  const tokenList = p.match(/^\/admin\/directory\/v1\/users\/([^/]+)\/tokens$/);
  if (tokenList) {
    const entry = tenant.find((e) => e.user.primaryEmail === decodeURIComponent(tokenList[1]));
    if (settings.failAllTokens) return googleError(res, 403, "Not Authorized to access this resource/api", "forbidden");
    if (entry?.box.tokensError) return googleError(res, entry.box.tokensError.status, entry.box.tokensError.message, entry.box.tokensError.reason);
    return send(res, 200, { items: entry?.box.tokens ?? [] });
  }
  const tokenDelete = p.match(/^\/admin\/directory\/v1\/users\/([^/]+)\/tokens\/([^/]+)$/);
  if (tokenDelete && req.method === "DELETE") {
    const entry = tenant.find((e) => e.user.primaryEmail === decodeURIComponent(tokenDelete[1]));
    const clientId = decodeURIComponent(tokenDelete[2]);
    const before = entry?.box.tokens.length ?? 0;
    if (entry) entry.box.tokens = entry.box.tokens.filter((t) => t.clientId !== clientId);
    if (!entry || entry.box.tokens.length === before) return googleError(res, 404, "Token not found", "notFound");
    res.writeHead(204); return res.end();
  }
  if (host.startsWith("gmail.googleapis.com")) {
    const entry = tenant.find((e) => e.user.primaryEmail === grant.subject);
    if (!entry) return googleError(res, 404, "Not Found", "notFound");
    if (p === "/gmail/v1/users/me/settings/autoForwarding" && req.method === "PUT") {
      if (!grant.scopes.some((s) => s.endsWith("/gmail.settings.sharing"))) return googleError(res, 403, "Insufficient Permission", "insufficientPermissions");
      entry.box.forwarding = { enabled: false, ...JSON.parse(body || "{}") };
      return send(res, 200, entry.box.forwarding);
    }
    const oneFilter = p.match(/^\/gmail\/v1\/users\/me\/settings\/filters\/([^/]+)$/);
    if (oneFilter) {
      const filter = entry.box.filters.find((f) => f.id === oneFilter[1]);
      if (!filter) return googleError(res, 404, "Filter not found", "notFound");
      if (req.method === "DELETE") {
        entry.box.filters = entry.box.filters.filter((f) => f !== filter);
        res.writeHead(204); return res.end();
      }
      return send(res, 200, filter);
    }
    if (entry.user.suspended) return googleError(res, 400, "Account is suspended", "failedPrecondition");
    if (entry.box.gmailError) return googleError(res, entry.box.gmailError.status, entry.box.gmailError.message, entry.box.gmailError.reason);
    if (p === "/gmail/v1/users/me/settings/sendAs") {
      return send(res, 200, { sendAs: [
        { sendAsEmail: `alias.${entry.user.primaryEmail}`, signature: "<div>Alias signature</div>" },
        { sendAsEmail: entry.user.primaryEmail, isPrimary: true, signature: entry.box.signature ?? "" },
      ] });
    }
    const oneSendAs = p.match(/^\/gmail\/v1\/users\/me\/settings\/sendAs\/([^/]+)$/);
    if (oneSendAs && req.method === "PATCH") {
      const address = decodeURIComponent(oneSendAs[1]);
      const b = JSON.parse(body || "{}");
      changes.push({ kind: "signature", subject: grant.subject, scopes: grant.scopes, address, signature: b.signature });
      if (address === entry.user.primaryEmail) entry.box.signature = b.signature;
      return send(res, 200, { sendAsEmail: address, signature: b.signature });
    }
    if (p === "/gmail/v1/users/me/settings/autoForwarding") return send(res, 200, entry.box.forwarding);
    if (p === "/gmail/v1/users/me/settings/filters") return send(res, 200, { filter: entry.box.filters });
  }
  return googleError(res, 404, `fake Google has no ${req.method} ${host}${p}`, "notFound");
}

const inner = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { send(res, 500, { error: { code: 500, message: String(e) } }); } catch {}
  });
});

const proxy = http.createServer((req, res) => {
  // Plain requests are the driver's control channel.
  const url = new URL(req.url, "http://control");
  if (url.pathname === "/__settings") {
    settings = { ...settings, ...Object.fromEntries([...url.searchParams].map(([k, v]) => [k, v === "true" ? true : v === "false" ? false : Number(v)])) };
    directoryPages = 0;
    return send(res, 200, settings);
  }
  if (url.pathname === "/__changes") {
    const out = { changes, groups: Object.fromEntries([...groups].map(([g, m]) => [g, Object.fromEntries(m)])), suspended: tenant.filter((e) => e.user.suspended).map((e) => e.user.primaryEmail) };
    if (url.searchParams.get("clear") === "true") changes = [];
    return send(res, 200, out);
  }
  // --- a stand-in for the release server the update check asks ---
  if (url.pathname === "/__release") {
    releaseHits.push({ method: req.method, headers: req.headers });
    if (release.status !== 200) return send(res, release.status, { message: "error" });
    return send(res, 200, { tag_name: release.tag, html_url: release.html, body: "notes" });
  }
  if (url.pathname === "/__setrelease") {
    release = { tag: url.searchParams.get("tag") ?? release.tag, html: url.searchParams.get("html") ?? release.html, status: Number(url.searchParams.get("status") ?? 200) };
    return send(res, 200, release);
  }
  if (url.pathname === "/__releasehits") {
    return send(res, 200, releaseHits);
  }
  if (url.pathname === "/__unlicense") {
    const user = url.searchParams.get("user");
    const before = licenses.length;
    licenses = licenses.filter(([u]) => u !== user);
    return send(res, 200, { removed: before - licenses.length });
  }
  if (url.pathname === "/__licenses") {
    return send(res, 200, licenses.map(([user, sku]) => ({ user, skuId: sku.skuId, productId: sku.productId })));
  }
  if (url.pathname === "/__tenant") {
    groups = freshGroups();
    tenant = buildTenant(Number(url.searchParams.get("count") ?? 130));
    licenses = buildLicenses(tenant);
    return send(res, 200, { accounts: tenant.length });
  }
  if (url.pathname === "/__dns") {
    return send(res, 200, dnsLog);
  }
  if (url.pathname === "/__new") {
    addSomethingNew(tenant);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/__tokens") {
    const out = { grants: tokenGrants, refusals: tokenRefusals };
    if (url.searchParams.get("clear") === "true") { tokenGrants = []; tokenRefusals = []; }
    return send(res, 200, out);
  }
  if (url.pathname === "/__log") {
    const out = log;
    if (url.searchParams.get("clear") === "true") log = [];
    return send(res, 200, out);
  }
  send(res, 404, { error: "unknown control request" });
});
proxy.on("connect", (req, socket) => {
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
  secure.on("error", () => secure.destroy());
  inner.emit("connection", secure);
});
proxy.listen(port, "127.0.0.1", () => console.log(`fake google listening on ${port}, ca at ${ca.crt}`));

// --- a DNS server for the email authentication check ----------------------------
// Answers TXT queries from DNS_TXT; any other name gets an empty answer, which is
// how a real server says "that name has no such record".
function readName(msg, offset) {
  const labels = [];
  while (msg[offset] !== 0) {
    const len = msg[offset];
    labels.push(msg.subarray(offset + 1, offset + 1 + len).toString("ascii"));
    offset += len + 1;
  }
  return { name: labels.join(".").toLowerCase(), end: offset + 1 };
}
const dnsLog = [];
const dns = dgram.createSocket("udp4");
dns.on("message", (msg, rinfo) => {
  try {
    const { name, end } = readName(msg, 12);
    const qtype = msg.readUInt16BE(end);
    const question = msg.subarray(12, end + 4);
    dnsLog.push({ name, qtype });
    const records = qtype === 16 ? DNS_TXT[name] ?? [] : [];
    const answers = records.map((text) => {
      const chunks = [];
      for (let i = 0; i < text.length; i += 255) {
        const part = Buffer.from(text.slice(i, i + 255), "ascii");
        chunks.push(Buffer.from([part.length]), part);
      }
      const rdata = Buffer.concat(chunks);
      const head = Buffer.alloc(12);
      head.writeUInt16BE(0xc00c, 0); // the name asked about
      head.writeUInt16BE(16, 2);     // TXT
      head.writeUInt16BE(1, 4);      // IN
      head.writeUInt32BE(60, 6);
      head.writeUInt16BE(rdata.length, 10);
      return Buffer.concat([head, rdata]);
    });
    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answers.length, 6);
    dns.send(Buffer.concat([header, question, ...answers]), rinfo.port, rinfo.address);
  } catch (e) {
    console.error("fake dns:", e);
  }
});
dns.bind(port + 1, "127.0.0.1");
