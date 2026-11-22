// The end-to-end run: the packaged app exactly as shipped, driven in a real
// browser, with fake-google.mjs answering as Google. README.md in this folder
// explains how it works and what it does and doesn't prove.
//
//   npm run test:e2e
//   npm run test:e2e -- --binary <path> --work <folder> --shots <folder> --keep
//
// One run from top to bottom, about a quarter of an hour. Every line printed
// is a statement about the app in plain words, marked "ok" or "FAIL"; the exit
// code is 0 only if all of them held.
import fs from "node:fs";
import path from "node:path";
import { ADMIN, BACKUP_CLIENT_ID, buildLicenses, buildTenant, expected, NOW, OWN_CLIENT_ID, SCHEDULER_CLIENT_ID, SKUS } from "./dataset.mjs";
import { claimWorkDir, defaultBinary, launchBrowser, parseArgs, repoRoot, requireBinary, signIn, sleep, startApp, startStandIn, stopOnInterrupt, writeServiceAccountKey } from "./harness.mjs";

const USAGE = `Usage: node scripts/e2e/run.mjs [options]

  --binary <path>        the packaged app to test
                         (default: the one in packaging/dist for this platform)
  --work <folder>        where the app keeps its data during the run
                         (default: a temporary folder)
  --shots <folder>       where to save screenshots (default: <work>/shots)
  --keep                 keep the temporary work folder after a clean run
  --app-port <n>         port for the app (default 3077)
  --stand-in-port <n>    port for the stand-in for Google, which also uses
                         the next port up for DNS (default 4443)`;

const args = parseArgs(
  process.argv.slice(2),
  { binary: defaultBinary(), work: "", shots: "", keep: false, "app-port": "3077", "stand-in-port": "4443" },
  USAGE
);
const binary = requireBinary(args.binary);
const work = claimWorkDir(args.work);
const workDir = work.dir;
const shotsDir = path.resolve(args.shots || path.join(workDir, "shots"));
const APP_PORT = Number(args["app-port"]);
const FAKE_PORT = Number(args["stand-in-port"]);
const BASE = `http://localhost:${APP_PORT}`;
// For an instance that lives for the length of this run and holds nothing real.
const PASSWORD = "e2e-password-for-a-throwaway-instance";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` - ${detail}` : ""}`);
}
const eq = (name, actual, wanted) =>
  check(name, JSON.stringify(actual) === JSON.stringify(wanted), `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);

fs.mkdirSync(shotsDir, { recursive: true });

let standIn;
let app;
let browser;
// Ctrl+C mid-run stops the app, the stand-in and the browser, not only this.
stopOnInterrupt(() => {
  console.log(`\nInterrupted after ${checks} checks. The app's data is in ${workDir}`);
  void browser?.close();
});
// Set when the run threw part-way: the checks after that point never ran, so
// the count is of the checks that did, not of the run.
let stoppedEarly = false;
try {
  // --- the stand-in for Google, then the app exactly as shipped --------------
  standIn = await startStandIn({ dir: path.join(workDir, "tls"), port: FAKE_PORT });
  const control = standIn.control;
  const keyFile = path.join(workDir, "service-account.json");
  writeServiceAccountKey(keyFile, { clientId: OWN_CLIENT_ID, clientEmail: "open-admin@e2e-project.iam.gserviceaccount.com" });
  app = await startApp({ binary, root: path.join(workDir, "root"), port: APP_PORT, password: PASSWORD, standIn });

  const { cookie, post } = await signIn(BASE, PASSWORD);
  const made = await post("/api/tenants", { name: "Example Corp", adminEmail: ADMIN, credentialsFile: keyFile, color: "blue" });
  if (made.status !== 201) throw new Error(`could not create tenant: ${made.status} ${await made.text()}`);
  await post("/api/config/onboarding", { completed: true });

  const want = expected(buildTenant());
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`${BASE}/login`);
  await page.fill("input[type='password']", PASSWORD);
  await page.click("button[type='submit']");
  await page.waitForURL(`${BASE}/`);

  const tile = (label) => page.locator("button[aria-pressed]", { hasText: label });
  const tileValue = async (label) => (await tile(label).locator("span.text-3xl").innerText()).trim();
  const tileStatus = async (label) => (await tile(label).locator("span.font-medium").last().innerText()).trim();
  const rows = () => page.locator("[data-slot='card-content'] > div.rounded-lg:not(.border-dashed)");
  const panelText = () => page.locator("[data-slot='card-content']").first().innerText();
  const tileFresh = async (label) => {
    const badge = tile(label).locator("[data-slot='badge']");
    return (await badge.count()) > 0 ? (await badge.innerText()).trim() : "";
  };
  const dialog = () => page.getByRole("dialog");
  /** Type the phrase the dialog asks for and press its confirm button. */
  const confirmWith = async (phrase, buttonName) => {
    await dialog().locator("#confirm-phrase").fill(phrase);
    await dialog().getByRole("button", { name: buttonName }).click();
  };
  const readAudit = () => {
    const file = path.join(workDir, "root", "data", "audit.log");
    return fs.existsSync(file)
      ? fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l))
      : [];
  };
  const waitDone = () => page.getByRole("status").filter({ hasText: /Complete\.|Cancelled|Stopped early/ }).waitFor({ timeout: 120_000 });

  console.log("\nBefore running");
  await page.getByRole("link", { name: "Security Check" }).first().click();
  await page.waitForURL(`${BASE}/security-check`);
  check("the sidebar links to the page", true);
  eq("tiles show no numbers before a run", await tileValue("No 2-Step Verification"), "–");
  eq("tiles say not checked yet", await tileStatus("No 2-Step Verification"), "Not checked yet");
  check("export is disabled with nothing to export", await page.getByRole("button", { name: "Export CSV" }).isDisabled());
  await page.screenshot({ path: path.join(shotsDir, "01-idle.png") });

  console.log("\nA full scan of a 131-account tenant (3 pages)");
  await control("/__log?clear=true");
  await page.getByRole("button", { name: "Run check" }).click();
  await waitDone();
  const statusLine = await page.getByRole("status").innerText();
  check("reports completion and how many accounts were checked", statusLine.includes("Complete.") && statusLine.includes(`${want.active} active accounts checked`), statusLine);
  check("reports the skipped accounts", statusLine.includes(`${want.skipped} suspended or archived skipped`), statusLine);

  eq("2-Step Verification count", await tileValue("No 2-Step Verification"), String(want.noTwoStep.length));
  eq("2-Step Verification is critical (an administrator is on the list)", await tileStatus("No 2-Step Verification"), "Needs attention");
  eq("inactive count at the default 90 days", await tileValue("Inactive accounts"), String(want.inactive90.length));
  eq("forwarding counts mailboxes, not rules", await tileValue("Mail forwarded outside"), String(want.forwardingMailboxes.size));
  eq("forwarding is critical (one forward deletes the original)", await tileStatus("Mail forwarded outside"), "Needs attention");
  eq("apps with broad access", await tileValue("Apps with broad access"), "2");
  check("says this is the first scan, with nothing to compare against", (await page.locator("body").innerText()).includes("First scan on this install."));
  eq("marks nothing as new on a first scan", await tileFresh("No 2-Step Verification"), "");
  await page.screenshot({ path: path.join(shotsDir, "02-two-step.png") });

  console.log("\n2-Step Verification detail");
  eq("lists every account without it", await rows().count(), want.noTwoStep.length);
  const first = await rows().first().innerText();
  check("puts the administrator first, labelled", first.includes(ADMIN) && first.includes("administrator"), first);

  console.log("\nInactive accounts detail");
  await tile("Inactive accounts").click();
  eq("lists the inactive accounts", await rows().count(), want.inactive90.length);
  const inactiveText = await page.locator("[data-slot='card-content']").innerText();
  check("shows never-signed-in accounts as such", inactiveText.includes("Never signed in"));
  check("does not list the account created three days ago", !inactiveText.includes("user003@example.com"));
  for (const [label, key] of [["30 days", "inactive30"], ["180 days", "inactive180"], ["1 year", "inactive365"]]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    eq(`threshold ${label}: list`, await rows().count(), want[key].length);
    eq(`threshold ${label}: tile`, await tileValue("Inactive accounts"), String(want[key].length));
  }
  await page.getByRole("button", { name: "90 days", exact: true }).click();
  await page.screenshot({ path: path.join(shotsDir, "03-inactive.png") });

  console.log("\nForwarding detail");
  await tile("Mail forwarded outside").click();
  eq("lists each forwarding rule", await rows().count(), want.forwardingRules);
  const fwd = await page.locator("[data-slot='card-content']").innerText();
  check("names the outside addresses", ["user005.private@personal.example", "collector@evil.example", "user077@outlook.example", "everything@evil.example"].every((t) => fwd.includes(t)), fwd);
  check("flags the one that deletes the original", fwd.includes("hides the original") && fwd.includes("deletes the original"));
  check("describes what a filter matches", fwd.includes("Filter on from:bank@example.net") && fwd.includes("Filter on all incoming mail"));
  check("does not list forwarding inside the organisation", !fwd.includes("team@example.org"));
  check("says how many internal forwards were left out", (await page.locator("[data-slot='card-description']").first().innerText()).includes(`${want.internalForwards} forwards to addresses inside the organisation are not listed`));
  eq("a forward to a domain alias counts as inside the organisation", [want.internalForwards, fwd.includes("user014@example.net")], [2, false]);
  check("never read the suspended account's mailbox", !fwd.includes("should-never-be-read"));
  await page.mouse.move(700, 880);
  await sleep(400);
  await page.screenshot({ path: path.join(shotsDir, "04-forwarding.png") });

  console.log("\nConnected apps detail");
  await tile("Apps with broad access").click();
  eq("lists every app once", await rows().count(), want.apps.size);
  const appText = await page.locator("[data-slot='card-content']").innerText();
  const order = ["Mail Merge Pro", "CloudBackup", "TeamChat", "QuickNotes"].map((n) => appText.indexOf(n));
  check("orders broad access first, then by how many people", order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), JSON.stringify(order));
  for (const [name, users] of want.apps) {
    check(`${name}: ${users.size} people`, new RegExp(`${name}[\\s\\S]*?${users.size} ${users.size === 1 ? "person" : "people"}`).test(appText));
  }
  check("marks the anonymous app", /CloudBackup[\s\S]*?anonymous/.test(appText));
  await page.getByRole("button", { name: /Mail Merge Pro/ }).click();
  const opened = await page.locator("[data-slot='card-content']").innerText();
  check("expanding an app shows its client id, people and raw permissions", opened.includes("1002-merge.apps.googleusercontent.com") && opened.includes("https://mail.google.com/") && opened.includes("user009@example.com"));
  await page.screenshot({ path: path.join(shotsDir, "05-apps.png") });

  console.log("\nDomain-wide delegation");
  eq("counts the entries worth reviewing", await tileValue("Domain-wide delegation"), "2");
  eq("asks for a look, never claims a clean result", await tileStatus("Domain-wide delegation"), "Worth a look");
  await tile("Domain-wide delegation").click();
  eq("lists every client the admin log mentions", await rows().count(), 3);
  const dwd = await page.locator("[data-slot='card-content']").innerText();
  const dwdOrder = [BACKUP_CLIENT_ID, OWN_CLIENT_ID, SCHEDULER_CLIENT_ID].map((id) => dwd.indexOf(id));
  check("orders current grants first, most recent first, removals last", dwdOrder.every((v, i) => v >= 0 && (i === 0 || v > dwdOrder[i - 1])), JSON.stringify(dwdOrder));
  check("shows who granted the unknown client, and how much it can reach", new RegExp(`${BACKUP_CLIENT_ID}[\\s\\S]*?Broad access[\\s\\S]*?Granted by ${ADMIN}`).test(dwd), dwd);
  check("recognises Open Admin's own entry and its one unneeded permission", new RegExp(`${OWN_CLIENT_ID}[\\s\\S]*?Open Admin[\\s\\S]*?1 permission it doesn't use`).test(dwd), dwd);
  check("shows the removed client as removed", new RegExp(`${SCHEDULER_CLIENT_ID.replace(/\./g, "\\.")}[\\s\\S]*?removed[\\s\\S]*?Removed by ${ADMIN}`).test(dwd), dwd);
  check("says plainly that this is not the full list", (await page.locator("[data-slot='card-description']").first().innerText()).includes("This is not the full list."));
  await page.getByRole("button", { name: new RegExp(OWN_CLIENT_ID) }).click();
  const ownOpen = await page.locator("[data-slot='card-content']").innerText();
  check("marks exactly the unneeded permission as unused", /gmail\.modify\s*unused/.test(ownOpen) && (ownOpen.match(/\bunused\b/g) ?? []).length === 1, ownOpen.slice(0, 900));
  await page.getByRole("button", { name: new RegExp(SCHEDULER_CLIENT_ID.replace(/\./g, "\\.")) }).click();
  const schedOpen = await page.locator("[data-slot='card-content']").innerText();
  check("shows a client's history, newest first", /removed by admin@example\.com[\s\S]*granted by user002@example\.com/.test(schedOpen), schedOpen.slice(-400));
  await page.mouse.move(700, 880);
  await sleep(400);
  await page.screenshot({ path: path.join(shotsDir, "05b-delegation.png") });

  console.log("\nEmail spoofing protection (SPF, DKIM, DMARC)");
  eq("counts the domains with something to fix, the alias included", await tileValue("Email spoofing protection"), "3");
  eq("is critical when a domain has no SPF or DMARC at all", await tileStatus("Email spoofing protection"), "Needs attention");
  await tile("Email spoofing protection").click();
  eq("lists both domains and the alias", await rows().count(), 3);
  const mail = await panelText();
  check("puts the worse domain first", mail.indexOf("example.org") >= 0 && mail.indexOf("example.org") < mail.indexOf("example.com"), mail.slice(0, 200));
  const orgCard = await rows().filter({ hasText: "example.org" }).innerText();
  const comCard = await rows().filter({ hasText: "example.com" }).innerText();
  check("example.org: no SPF, no DMARC, DKIM can't be told", /SPF[\s\S]*Missing or broken[\s\S]*No SPF record[\s\S]*DKIM[\s\S]*Can't tell[\s\S]*DMARC[\s\S]*Missing or broken[\s\S]*No DMARC policy/.test(orgCard), orgCard);
  check("example.com: SPF and DKIM in place, DMARC monitor-only", /SPF[\s\S]*In place[\s\S]*DKIM[\s\S]*In place[\s\S]*DMARC[\s\S]*Weak[\s\S]*monitor only/.test(comCard) && comCard.includes("primary"), comCard);
  await rows().filter({ hasText: "example.com" }).getByRole("button", { name: "Show records" }).click();
  check("shows the published record on request", (await rows().filter({ hasText: "example.com" }).innerText()).includes("v=spf1 include:_spf.google.com ~all"));
  const dnsAsked = (await control("/__dns")).map((q) => q.name);
  check("asked DNS in the right places", ["example.com", "example.org", "_dmarc.example.com", "_dmarc.example.org", "google._domainkey.example.com", "google._domainkey.example.org"].every((n) => dnsAsked.includes(n)), JSON.stringify([...new Set(dnsAsked)]));
  await page.mouse.move(700, 880);
  await sleep(400);
  await page.screenshot({ path: path.join(shotsDir, "05c-email-auth.png") });

  console.log("\nTesting Open Admin's own key");
  await tile("Domain-wide delegation").click();
  await control("/__tokens?clear=true");
  check("does not test the key until asked", !(await panelText()).includes("not granted"));
  await page.getByRole("button", { name: "Run the test" }).click();
  await page.getByRole("button", { name: "Test again" }).waitFor();
  const keyText = await page.locator("div.border-dashed").innerText();
  check("reports the one broad permission the key was given and doesn't need", /Gmail \(read and change\): granted, and not needed/.test(keyText) && keyText.includes("gmail.modify"), keyText);
  eq("reports the other five as not granted", (keyText.match(/: not granted/g) ?? []).length, 5);
  const probe = await control("/__tokens?clear=true");
  check("asked for one scope at a time, as the admin, and made no API call with the tokens", probe.grants.length === 1 && probe.grants[0].scopes.length === 1 && probe.grants[0].subject === ADMIN && probe.refusals.length === 5, JSON.stringify(probe).slice(0, 300));
  check("recorded the test in the audit log", readAudit().some((e) => e.action === "security_check.own_key_test" && e.outcome === "success" && e.params.unneededScopesGranted?.length === 1));
  await page.screenshot({ path: path.join(shotsDir, "05d-own-key.png") });

  console.log("\nAccounts that could not be read");
  const unread = page.locator("[data-slot='card']", { hasText: "couldn't be read" });
  const unreadText = await unread.innerText();
  check("says which checks are incomplete and for how many", unreadText.includes("Forwarding settings for 1 mailbox") && unreadText.includes("connected apps for 1 account"), unreadText);
  await unread.getByRole("button", { name: "Show details" }).click();
  const details = await unread.innerText();
  check("names the accounts and Google's reason", details.includes("user041@example.com") && details.includes("Mail service not enabled") && details.includes("user042@example.com") && details.includes("Not Authorized"), details);
  check("mentions accounts without a mailbox", (await page.locator("main, body").first().innerText()).includes(`${want.withoutMailbox} active accounts have no Gmail mailbox`));

  console.log("\nWhat the app asked Google for");
  const log = await control("/__log?clear=true");
  check("every request was a read", log.every((r) => r.method === "GET"), JSON.stringify([...new Set(log.map((r) => r.method))]));
  const gmail = log.filter((r) => r.host.startsWith("gmail."));
  check("mailboxes were read with the basic settings scope only", gmail.length > 0 && gmail.every((r) => r.scopes.length === 1 && r.scopes[0].endsWith("/gmail.settings.basic")));
  const suspended = new Set(buildTenant().filter((e) => e.user.suspended || e.user.archived).map((e) => e.user.primaryEmail));
  check("no suspended or archived mailbox was touched", gmail.every((r) => !suspended.has(r.subject)));
  check("no suspended or archived account's tokens were read", log.filter((r) => r.path.endsWith("/tokens")).every((r) => !suspended.has(decodeURIComponent(r.path.split("/")[5]))));
  eq("the directory was read in three pages", log.filter((r) => r.path === "/admin/directory/v1/users").length, 3);
  eq("two settings reads per readable mailbox", gmail.length, 2 * (want.active - want.withoutMailbox));
  eq("one token list per active account", log.filter((r) => r.path.endsWith("/tokens")).length, want.active);
  const reports = log.filter((r) => r.path.startsWith("/admin/reports/"));
  check("the admin log was read as the admin with the reports scope only", reports.length === 2 && reports.every((r) => r.subject === ADMIN && r.scopes.length === 1 && r.scopes[0].endsWith("/admin.reports.audit.readonly")), JSON.stringify(reports));

  console.log("\nCSV export");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  const csvPath = path.join(workDir, "export.csv");
  await download.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, "utf-8").split("\n");
  check("is named for the day", /^security-check-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());
  const count = (label) => csv.filter((l) => l.startsWith(`"${label}"`)).length;
  eq("one row per account without 2-Step Verification", count("No 2-Step Verification"), want.noTwoStep.length);
  eq("one row per inactive account", count("Inactive account"), want.inactive90.length);
  eq("one row per forwarding rule", count("Mail forwarded outside"), want.forwardingRules);
  eq("one row per app per person", count("Connected app"), [...want.apps.values()].reduce((n, s) => n + s.size, 0));
  eq("one row per delegated client", count("Domain-wide delegation"), 3);
  eq("one row per email record that isn't in place", count("Email authentication"), 7);

  console.log("\nWhat's new since the last scan");
  await page.getByRole("button", { name: "Run again" }).click();
  await waitDone();
  const sameLine = await page.locator("body").innerText();
  check("a second identical scan is compared with the first and finds nothing new", /Compared with the scan on [^\n]*: nothing new\./.test(sameLine), sameLine.match(/Compared[^\n]*/)?.[0]);
  for (const label of ["No 2-Step Verification", "Inactive accounts", "Mail forwarded outside", "Apps with broad access", "Domain-wide delegation", "Email spoofing protection"]) {
    eq(`${label}: nothing marked new`, await tileFresh(label), "");
  }
  check("offers no filter when nothing is new", (await page.getByRole("button", { name: "Only show what's new" }).count()) === 0);
  await control("/__new");
  await page.getByRole("button", { name: "Run again" }).click();
  await waitDone();
  eq("the new forward is counted as new", [await tileValue("Mail forwarded outside"), await tileFresh("Mail forwarded outside")], [String(want.forwardingMailboxes.size + 1), "1 new"]);
  eq("the new broad app is counted as new", [await tileValue("Apps with broad access"), await tileFresh("Apps with broad access")], ["3", "1 new"]);
  eq("checks with nothing new carry no marker", await tileFresh("No 2-Step Verification"), "");
  await tile("Mail forwarded outside").click();
  const newRow = rows().filter({ hasText: "user052@example.com" });
  check("the new forward's row is marked", (await newRow.innerText()).includes("new"));
  check("rows that were there before are not", !(await rows().filter({ hasText: "user005@example.com" }).locator("[data-slot='badge']").allInnerTexts()).includes("new"));
  await page.getByRole("button", { name: "Only show what's new" }).click();
  eq("the filter leaves only the new forward", await rows().count(), 1);
  await tile("Apps with broad access").click();
  eq("the filter applies to every list", [await rows().count(), (await panelText()).includes("ShadowSync")], [1, true]);
  await tile("No 2-Step Verification").click();
  check("a list with nothing new says so", (await panelText()).includes("Nothing new here since the last scan."));
  await tile("Mail forwarded outside").click();
  await page.mouse.move(700, 880);
  await sleep(400);
  await page.screenshot({ path: path.join(shotsDir, "05e-new-since.png") });
  await page.getByRole("button", { name: "Only show what's new" }).click();
  eq("turning the filter off brings the rest back", await rows().count(), want.forwardingRules + 1);

  console.log("\nFixing: turn off forwarding");
  await control("/__log?clear=true");
  const auditBefore = readAudit().length;
  await rows().filter({ hasText: "user005@example.com" }).getByRole("button", { name: "Turn off…" }).click();
  const offDialog = await dialog().innerText();
  check("the dialog says exactly what will change, and against which tenant", offDialog.includes("user005@example.com") && offDialog.includes("user005.private@personal.example") && offDialog.includes("Example Corp"), offDialog);
  check("confirm is disabled until the mailbox address is typed", await dialog().getByRole("button", { name: "Turn off forwarding" }).isDisabled());
  await dialog().locator("#confirm-phrase").fill("user005@example.co");
  check("and stays disabled for a near miss", await dialog().getByRole("button", { name: "Turn off forwarding" }).isDisabled());
  await confirmWith("user005@example.com", "Turn off forwarding");
  await dialog().waitFor({ state: "hidden" });
  check("reports what was done", (await page.locator("[role=alert]").first().innerText()).includes("Turned off forwarding from user005@example.com to user005.private@personal.example"));
  eq("the row is gone", await rows().filter({ hasText: "user005@example.com" }).count(), 0);
  eq("and the tile counts one mailbox fewer", await tileValue("Mail forwarded outside"), String(want.forwardingMailboxes.size));
  let wlog = await control("/__log?clear=true");
  eq("Google was asked to read the setting, then turn it off, as the mailbox owner", wlog.map((r) => [r.method, r.path, r.subject]), [["GET", "/gmail/v1/users/me/settings/autoForwarding", "user005@example.com"], ["PUT", "/gmail/v1/users/me/settings/autoForwarding", "user005@example.com"]]);

  console.log("\nFixing: delete a forwarding filter");
  await rows().filter({ hasText: "collector@evil.example" }).getByRole("button", { name: "Delete filter…" }).click();
  check("warns that the whole filter goes", (await dialog().innerText()).includes("The whole filter is deleted"));
  await confirmWith("user033@example.com", "Delete filter");
  await dialog().waitFor({ state: "hidden" });
  eq("the filter's row is gone", await rows().filter({ hasText: "collector@evil.example" }).count(), 0);
  wlog = await control("/__log?clear=true");
  eq("only that filter was fetched and deleted", wlog.map((r) => [r.method, r.path]), [["GET", "/gmail/v1/users/me/settings/filters/a"], ["DELETE", "/gmail/v1/users/me/settings/filters/a"]]);

  console.log("\nFixing: what the server refuses");
  const fixApi = (p, body) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) });
  let r = await fixApi("/api/admin/security-check/forwarding", { user: "user077@example.com", kind: "auto-forward", target: "user077@outlook.example", confirm: "nope" });
  eq("a request without the typed confirmation", r.status, 400);
  r = await fixApi("/api/admin/security-check/forwarding", { user: "user077@example.com", kind: "auto-forward", target: "somewhere-else@evil.example", confirm: "user077@example.com" });
  eq("a forward that isn't the one the operator saw (409, scan again)", [r.status, (await r.json()).error.includes("Run the check again")], [409, true]);
  r = await fixApi("/api/admin/security-check/forwarding", { user: "user033@example.com", kind: "filter", filterId: "b", target: "collector@evil.example", confirm: "user033@example.com" });
  eq("a filter that only labels mail is never deleted", r.status, 409);
  r = await fixApi("/api/admin/security-check/revoke-app", { clientId: "1001-chat.apps.googleusercontent.com", users: ["user002@example.com", "user004@example.com"], confirm: "user002@example.com" });
  eq("several accounts confirmed as if they were one", r.status, 400);
  r = await fixApi("/api/admin/security-check/revoke-app", { clientId: "1001-chat.apps.googleusercontent.com", users: Array.from({ length: 26 }, (_, i) => `u${i}@example.com`), confirm: "REVOKE" });
  eq("more accounts than one request may carry", r.status, 400);
  r = await fetch(`${BASE}/api/admin/security-check/forwarding`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", cookie }, body: "{}" });
  eq("a request from another site", r.status, 403);
  wlog = await control("/__log?clear=true");
  check("none of those wrote anything to Google", wlog.every((x) => x.method === "GET"), JSON.stringify(wlog.map((x) => [x.method, x.path])));

  console.log("\nFixing: revoke an app");
  await tile("Apps with broad access").click();
  await page.getByRole("button", { name: /CloudBackup/ }).click();
  await rows().filter({ hasText: "CloudBackup" }).locator("li", { hasText: "user004@example.com" }).getByRole("button", { name: "Revoke" }).click();
  await confirmWith("user004@example.com", "Revoke access");
  await dialog().waitFor({ state: "hidden" });
  check("revoking for one person leaves the other", /CloudBackup[\s\S]*?1 person/.test(await panelText()));
  wlog = await control("/__log?clear=true");
  eq("exactly one token was deleted", wlog.map((x) => [x.method, decodeURIComponent(x.path)]), [["DELETE", "/admin/directory/v1/users/user004@example.com/tokens/1004-backup.apps.googleusercontent.com"]]);
  await page.getByRole("button", { name: /Mail Merge Pro/ }).click();
  // One account's apps couldn't be read in this scan, so the page must not
  // promise "everyone": it revokes for the accounts it found, and says so.
  await page.getByRole("button", { name: "Revoke for the 13 found…" }).click();
  check("revoking for every account found needs the word REVOKE", (await dialog().innerText()).includes("REVOKE") && (await dialog().getByRole("button", { name: "Revoke for these accounts" }).isDisabled()));
  check("and says the scan did not read every account", (await dialog().innerText()).includes("did not read every account"), await dialog().innerText());
  await confirmWith("REVOKE", "Revoke for these accounts");
  await dialog().waitFor({ state: "hidden" });
  check("the app is gone from the list", !(await panelText()).includes("Mail Merge Pro"));
  check("and the success message counts the accounts", (await page.locator("[role=alert]").first().innerText()).includes("for 13 accounts"));
  wlog = await control("/__log?clear=true");
  eq("thirteen tokens were deleted, all for that app", [wlog.length, wlog.every((x) => x.method === "DELETE" && x.path.endsWith("/tokens/1002-merge.apps.googleusercontent.com"))], [13, true]);

  console.log("\nFixing: audit log and a fresh scan");
  const fixAudit = readAudit().slice(auditBefore);
  const actions = fixAudit.filter((e) => e.outcome === "success").map((e) => e.action);
  check("every change was audited", ["security_check.forwarding_off", "security_check.forwarding_filter_delete", "security_check.app_revoke"].every((a) => actions.includes(a)), JSON.stringify(actions));
  check("the refused requests were audited as errors", fixAudit.filter((e) => e.outcome === "error").length >= 4);
  check("audit entries name the tenant and who did it", fixAudit.every((e) => e.tenantName === "Example Corp" && typeof e.actor === "string" && e.actor.length > 0), JSON.stringify(fixAudit[0]));
  await page.getByRole("button", { name: "Run again" }).click();
  await waitDone();
  eq("a fresh scan agrees: two fewer mailboxes forwarding outside", await tileValue("Mail forwarded outside"), String(want.forwardingMailboxes.size - 1));
  eq("and one fewer app with broad access", await tileValue("Apps with broad access"), "2");

  console.log("\nFixing: hand an inactive account to Offboarding");
  await tile("Inactive accounts").click();
  const offboard = rows().first().getByRole("link", { name: "Offboard…" });
  const offboardHref = await offboard.getAttribute("href");
  check("the link names the account", /^\/offboarding\?user=user\d+%40example\.com$/.test(offboardHref ?? ""), offboardHref);
  await offboard.click();
  await page.waitForURL(/\/offboarding\?user=/);
  await page.waitForFunction((v) => [...document.querySelectorAll("input")].some((i) => i.value === v), decodeURIComponent(offboardHref.split("=")[1]));
  check("Offboarding opens with the account filled in and nothing run", (await control("/__log?clear=true")).every((x) => x.method === "GET"));
  await page.goBack();
  await page.waitForURL(`${BASE}/security-check`);
  await page.getByRole("button", { name: "Run check" }).click();
  await waitDone();

  console.log("\nDark theme and a narrow window");
  await page.evaluate(() => { localStorage.setItem("theme", "dark"); document.documentElement.classList.add("dark"); });
  await tile("Mail forwarded outside").click();
  await page.mouse.move(700, 880);
  await sleep(400);
  await page.screenshot({ path: path.join(shotsDir, "06-forwarding-dark.png") });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.screenshot({ path: path.join(shotsDir, "07-narrow-dark.png") });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 900px", overflow <= 0, `${overflow}px`);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.evaluate(() => { localStorage.setItem("theme", "light"); document.documentElement.classList.remove("dark"); });

  console.log("\nCancelling part-way");
  await control("/__settings?latencyMs=60");
  await page.getByRole("button", { name: "Run again" }).click();
  await page.getByRole("status").filter({ hasText: /\d+ active accounts checked/ }).filter({ hasNotText: /^Checking… 0 / }).waitFor();
  await page.waitForFunction(() => /Checking… [1-9]/.test(document.querySelector("[role=status]")?.textContent ?? ""), null, { timeout: 60_000 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await waitDone();
  const cancelled = await page.getByRole("status").innerText();
  check("says the results are partial", cancelled.includes("Cancelled: results cover only part of the tenant."), cancelled);
  const checkedSoFar = Number(cancelled.match(/([\d,]+) active accounts? checked/)?.[1]?.replace(/,/g, ""));
  check("stopped before the end", checkedSoFar > 0 && checkedSoFar < want.active, String(checkedSoFar));
  const statuses = [];
  for (const label of ["No 2-Step Verification", "Inactive accounts", "Mail forwarded outside", "Apps with broad access", "Domain-wide delegation", "Email spoofing protection"]) statuses.push(await tileStatus(label));
  check("no check claims a clean result after a partial scan", !statuses.includes("Nothing found"), JSON.stringify(statuses));
  await sleep(1500);
  // Requests already on their way when Cancel was pressed may still land.
  // Forget those, then see that no new ones follow.
  await control("/__log?clear=true");
  await sleep(1500);
  eq("stops calling Google once cancelled", (await control("/__log?clear=true")).length, 0);
  await page.screenshot({ path: path.join(shotsDir, "08-cancelled.png") });
  await control("/__settings?latencyMs=0");

  console.log("\nGoogle refusing part-way through");
  await control("/__settings?failDirectoryAfterPages=1");
  await page.getByRole("button", { name: "Run again" }).click();
  await waitDone();
  const failedLine = await page.getByRole("status").innerText();
  const banner = await page.locator("[role=alert]").first().innerText();
  check("shows the error and that earlier results are kept", banner.includes("stopped part-way") && banner.includes("Not Authorized"), banner);
  check("marks the scan as incomplete", failedLine.includes("Stopped early"), failedLine);
  check("keeps the first page's findings", Number(await tileValue("No 2-Step Verification")) > 0);
  await page.screenshot({ path: path.join(shotsDir, "09-failed-midway.png") });
  await control("/__settings?failDirectoryAfterPages=0");

  console.log("\nA permission missing for every account");
  await control("/__settings?failAllTokens=true");
  await page.getByRole("button", { name: "Run again" }).click();
  await waitDone();
  eq("the apps check does not claim a clean result", await tileStatus("Apps with broad access"), "Incomplete");
  const all = await page.locator("[data-slot='card']", { hasText: "couldn't be read" }).innerText();
  check("reports every account as unread and points at Setup", all.includes(`connected apps for ${want.active} accounts`) && all.includes("check Setup"), all);
  eq("the other checks still complete", await tileValue("No 2-Step Verification"), String(want.noTwoStep.length));
  await control("/__settings?failAllTokens=false");

  console.log("\nThe admin log can't be read");
  await control("/__settings?failReports=true");
  await page.getByRole("button", { name: "Run again" }).click();
  await waitDone();
  eq("the delegation check says it is incomplete", await tileStatus("Domain-wide delegation"), "Incomplete");
  eq("and shows no number", await tileValue("Domain-wide delegation"), "–");
  await tile("Domain-wide delegation").click();
  const dwdFail = await page.locator("[data-slot='card-content']").innerText();
  check("explains why and which permission it needs", dwdFail.includes("The admin log could not be read.") && dwdFail.includes("Not Authorized") && dwdFail.includes("admin.reports.audit.readonly"), dwdFail);
  eq("the account checks are unaffected", await tileValue("No 2-Step Verification"), String(want.noTwoStep.length));
  await page.screenshot({ path: path.join(shotsDir, "09b-delegation-unreadable.png") });
  await control("/__settings?failReports=false");

  console.log("\nNo delegation changes in the log");
  await control("/__settings?noDelegation=true");
  await page.getByRole("button", { name: "Run again" }).click();
  await waitDone();
  eq("says there is nothing recent, not that all is well", [await tileValue("Domain-wide delegation"), await tileStatus("Domain-wide delegation")], ["0", "Nothing recent to review"]);
  await tile("Domain-wide delegation").click();
  check("the empty state is honest about older entries", (await page.locator("[data-slot='card-content']").innerText()).includes("That says nothing about older entries."));
  await control("/__settings?noDelegation=false");

  console.log("\nA tenant with nothing wrong");
  await control("/__tenant?count=0");
  await page.getByRole("button", { name: "Run again" }).click();
  await waitDone();
  // Only the admin remains, and the admin has no 2SV: fix that by checking the other three.
  for (const label of ["Inactive accounts", "Mail forwarded outside", "Apps with broad access"]) {
    eq(`${label}: clean result`, [await tileValue(label), await tileStatus(label)], ["0", "Nothing found"]);
  }
  await tile("Mail forwarded outside").click();
  check("the empty state says so plainly", (await page.locator("[data-slot='card-content']").innerText()).includes("No mailbox forwards mail outside the organisation."));
  await page.screenshot({ path: path.join(shotsDir, "10-clean.png") });

  console.log("\nSharing Audit: shared drives");
  await page.goto(`${BASE}/sharing-audit`);
  await control("/__log?clear=true");
  await page.getByRole("button", { name: "Scan shared drives" }).click();
  const driveStatus = page.getByTestId("shared-drives-status");
  await driveStatus.filter({ hasText: "Complete." }).waitFor({ timeout: 60_000 });
  const driveLine = await driveStatus.innerText();
  check("scans every shared drive", driveLine.includes("3 of 3 shared drives") && driveLine.includes("4 files checked"), driveLine);
  const driveCard = page.getByTestId("shared-drives-results");
  const driveSummary = await driveCard.locator("[data-slot='card-description']").innerText();
  check("summarises what is shared outside", driveSummary.includes("1 drive with something shared outside") && driveSummary.includes("1 outside member") && driveSummary.includes("2 files shared outside"), driveSummary);
  check("says when a drive could not be fully read", driveSummary.includes("1 drive could not be fully read"), driveSummary);
  const driveRow = (name) => driveCard.locator("div.rounded-lg", { has: page.getByRole("button", { name: new RegExp(`^${name}`) }) });
  check("flags the drive with an outside member and outside files", /1 outside member[\s\S]*2 files shared outside/.test(await driveRow("Sales").innerText()));
  check("passes the clean drive", (await driveRow("HR").innerText()).includes("nothing outside"));
  check("marks the drive it could not read", (await driveRow("Projects").innerText()).includes("not fully read"));
  await driveCard.getByRole("button", { name: /^Sales/ }).click();
  const sales = await driveRow("Sales").innerText();
  check("names the outside member and their role", sales.includes("agency@partner.example") && sales.includes("(writer)"), sales);
  check("names the files and who they are shared with", /Contract[\s\S]*counsel@lawfirm\.example \(writer\)/.test(sales) && /Price list[\s\S]*Anyone with the link \(reader\)/.test(sales), sales);
  check("does not repeat the drive's member against the file that inherits them", (sales.match(/agency@partner\.example/g) ?? []).length === 1, sales);
  check("says who the files were read as", sales.includes("as user001@example.com"));
  await driveCard.getByRole("button", { name: /^Projects/ }).click();
  check("explains why a drive's files were not checked", (await driveRow("Projects").innerText()).includes("there is no one to read its files as"));
  check("and does not claim its files are clean", (await driveRow("Projects").innerText()).includes("Not known"));
  await page.screenshot({ path: path.join(shotsDir, "11-shared-drives.png") });
  const dlog = (await control("/__log?clear=true")).filter((x) => x.path.startsWith("/drive/"));
  check("every Drive request was a read", dlog.length > 0 && dlog.every((x) => x.method === "GET"));
  check("drives and their members were read as the admin", dlog.filter((x) => x.path === "/drive/v3/drives" || /^\/drive\/v3\/files\/0AE/.test(x.path)).every((x) => x.subject === ADMIN));
  check("files were read as a member, with the metadata scope", dlog.filter((x) => x.path === "/drive/v3/files").every((x) => ["user001@example.com", "user002@example.com"].includes(x.subject) && x.scopes.length === 1 && x.scopes[0].endsWith("/drive.metadata.readonly")), JSON.stringify(dlog.filter((x) => x.path === "/drive/v3/files").map((x) => [x.subject, x.scopes])));
  check("the unreachable drive's files were never requested", !dlog.some((x) => x.path.includes("file-secret")));
  const [driveCsv] = await Promise.all([page.waitForEvent("download"), page.getByTestId("shared-drives-card").getByRole("button", { name: "Export CSV" }).click()]);
  const driveCsvPath = path.join(workDir, "shared-drives.csv");
  await driveCsv.saveAs(driveCsvPath);
  const driveCsvRows = fs.readFileSync(driveCsvPath, "utf-8").split("\n");
  const driveCsvData = driveCsvRows.slice(1);
  eq("the export has one row per outside member and per outside share", [driveCsvData.filter((l) => l.includes('"drive member"')).length, driveCsvData.filter((l) => l.includes(',"file",')).length], [1, 2]);
  // One drive couldn't be read in full: the file says so at the top, and
  // names the drive, so it can't pass for a complete picture.
  eq("and says it is incomplete, naming the drive it couldn't read", [driveCsvData.length, driveCsvData[0].startsWith('"INCOMPLETE"'), driveCsvData.filter((l) => l.includes('"drive not fully read"')).length], [5, true, 1]);

  // ------------------------------------------------------------------ New User
  console.log("\nNew User: create an account");
  await control("/__tenant");
  await control("/__changes?clear=true");
  await control("/__settings?groupDelayMs=4000");
  const auditText = () => {
    const file = path.join(workDir, "root", "data", "audit.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  };
  const people = buildTenant().map((e) => e.user).filter((u) => u.primaryEmail !== ADMIN);
  const activePeople = people.filter((u) => !u.suspended && !u.archived).map((u) => u.primaryEmail);
  const suspendedPerson = people.find((u) => u.suspended).primaryEmail;

  await page.goto(`${BASE}/new-user`);
  await page.getByTestId("new-user-domain").waitFor();
  await page.getByTestId("new-user-domain").click();
  const offered = (await page.getByRole("option").allInnerTexts()).map((t) => t.trim());
  await page.keyboard.press("Escape");
  eq("offers the full domains and not the alias", offered, ["example.com (primary)", "example.org"]);
  check("the create button waits for a complete form", await page.getByRole("button", { name: "Review & create account" }).isDisabled());

  await page.fill("#givenName", "Zoë");
  await page.fill("#familyName", "Müller-Smith");
  eq("suggests a plain username from the name", await page.inputValue("#username"), "zoe.mullersmith");
  await page.fill("#groups", "all-staff\nsales@example.com\nno-such-group\nnot a group!");
  check("says which line isn't a group address", (await page.getByTestId("new-user-problem").innerText()).includes("not a group!"));
  check("and won't go on while one is wrong", await page.getByRole("button", { name: "Review & create account" }).isDisabled());
  await page.fill("#groups", "all-staff\nsales@example.com\nno-such-group");
  await page.getByRole("button", { name: "Review & create account" }).click();
  const NEW = "zoe.mullersmith@example.com";
  const createDialog = await dialog().innerText();
  check("the dialog names the account, the tenant and the groups in full", createDialog.includes(NEW) && createDialog.includes("Example Corp") && createDialog.includes("all-staff@example.com, sales@example.com, no-such-group@example.com"), createDialog);
  check("nothing can be created before the address is typed", await dialog().getByRole("button", { name: "Create account" }).isDisabled());
  eq("and nothing has been sent to Google yet", (await control("/__changes")).changes, []);
  await confirmWith(NEW, "Create account");
  const result = page.getByTestId("new-user-result");
  await result.waitFor({ timeout: 30_000 });
  const shown = (await page.getByTestId("new-user-password").innerText()).trim();
  let made1 = (await control("/__changes")).changes.filter((c) => c.kind === "create");
  eq("creates exactly one account, as the admin", made1.map((c) => [c.subject, c.body.primaryEmail]), [[ADMIN, NEW]]);
  eq("with the name, the top-level unit and a forced password change", [made1[0].body.name, made1[0].body.orgUnitPath, made1[0].body.changePasswordAtNextLogin], [{ givenName: "Zoë", familyName: "Müller-Smith" }, "/", true]);
  check("shows the same password Google was given", shown.length === 16 && shown === made1[0].body.password, `${shown.length} chars`);
  check("the form is cleared so a second click can't repeat it", (await page.inputValue("#givenName")) === "" && (await page.inputValue("#username")) === "");

  const groupList = page.getByTestId("new-user-groups");
  await page.waitForFunction(() => {
    const t = document.querySelector("[data-testid='new-user-groups']")?.textContent ?? "";
    return t !== "" && !/Waiting|Adding/.test(t);
  }, null, { timeout: 60_000 });
  const groupRow = (g) => groupList.locator("li", { hasText: g });
  check("joins the first group once the new account is ready", (await groupRow("all-staff@example.com").innerText()).includes("Added"));
  check("joins the second", (await groupRow("sales@example.com").innerText()).includes("Added"));
  const missing = await groupRow("no-such-group@example.com").innerText();
  check("says plainly when a group doesn't exist, and offers another try", missing.includes("Not added") && missing.includes("There is no group with this address.") && missing.includes("Try again"), missing);
  const after1 = await control("/__changes");
  check("waited for the new account rather than giving up", after1.changes.filter((c) => c.kind === "groupAddTooSoon" && c.group === "all-staff@example.com").length >= 1);
  eq("is an ordinary member of both groups", [after1.groups["all-staff@example.com"][NEW], after1.groups["sales@example.com"][NEW]], ["MEMBER", "MEMBER"]);
  check("didn't keep asking about a group that doesn't exist", after1.changes.filter((c) => c.kind === "groupAddTooSoon" && c.group === "no-such-group@example.com").length === 0);
  check("group changes used the groups permission, as the admin", after1.changes.filter((c) => c.kind === "groupAdd").every((c) => c.subject === ADMIN && c.scopes.length === 1 && c.scopes[0].endsWith("/admin.directory.group")));
  const createdEntry = readAudit().filter((a) => a.action === "user.create");
  eq("the audit log records who was created", createdEntry.map((a) => [a.outcome, a.params]), [["success", { user: NEW, orgUnitPath: "/" }]]);
  check("the password is not in the audit log", !auditText().includes(shown));
  check("nor in anything the app printed", !app.output().includes(shown));
  await page.screenshot({ path: path.join(shotsDir, "12-new-user.png"), fullPage: true });

  await control("/__settings?groupDelayMs=0");
  await page.fill("#givenName", "Zoe");
  await page.fill("#familyName", "Mullersmith");
  await page.getByRole("button", { name: "Review & create account" }).click();
  await confirmWith(NEW, "Create account");
  await dialog().getByRole("alert").waitFor();
  check("refuses an address that is taken, inside the dialog", (await dialog().getByRole("alert").innerText()).includes("already belongs to an account"));
  await dialog().getByRole("button", { name: "Cancel" }).click();
  eq("and creates nothing", (await control("/__changes")).changes.filter((c) => c.kind === "create").length, 1);
  check("the first account's password is still on screen", (await page.getByTestId("new-user-password").innerText()).trim() === shown);
  await result.getByRole("button", { name: "I've copied it, clear this" }).click();
  eq("clearing removes it from the page", await page.getByTestId("new-user-result").count(), 0);
  check("and it is nowhere in the page any more", !(await page.content()).includes(shown));

  const tryCreate = async (body) => { const r = await post("/api/admin/user/create", body); return [r.status, (await r.json()).error ?? ""]; };
  const person = { givenName: "Sam", familyName: "Lee" };
  let [st, why] = await tryCreate({ ...person, primaryEmail: "sam.lee@example.net", confirm: "sam.lee@example.net" });
  check("the server refuses a domain alias", st === 400 && why.includes("domain alias"), `${st} ${why}`);
  [st, why] = await tryCreate({ ...person, primaryEmail: "sam.lee@elsewhere.example", confirm: "sam.lee@elsewhere.example" });
  check("and a domain that isn't the organisation's", st === 400 && why.includes("not a verified domain"), `${st} ${why}`);
  [st, why] = await tryCreate({ ...person, primaryEmail: "sam.lee@example.com" });
  check("and a request without the typed confirmation", st === 400 && why.includes("confirm"), `${st} ${why}`);
  [st, why] = await tryCreate({ ...person, primaryEmail: "sam.lee@example.com", confirm: "sam.lee@example.com", orgUnitPath: "Sales" });
  check("and an organisational unit that isn't a path", st === 400 && why.includes('start with "/"'), `${st} ${why}`);
  eq("none of which reached Google as a create", (await control("/__changes")).changes.filter((c) => c.kind === "create").length, 1);

  console.log("\nNew User: reset a password");
  await control("/__changes?clear=true");
  const resetCard = page.getByTestId("password-reset-card");
  const resetOne = async (address, { signOut = false } = {}) => {
    await page.fill("#resetEmail", address);
    if ((await page.getByTestId("password-reset-signout").isChecked()) !== signOut) await page.getByTestId("password-reset-signout").click();
    await resetCard.getByRole("button", { name: "Review & reset password" }).click();
    await confirmWith(address, "Reset password");
  };
  const [p1, p2] = activePeople;
  await resetOne(p1, { signOut: true });
  await page.getByTestId("password-reset-result").waitFor({ timeout: 30_000 });
  const reset1 = (await page.getByTestId("password-reset-password").innerText()).trim();
  let ch = (await control("/__changes?clear=true")).changes;
  eq("sets a new password that must be changed, then signs them out", ch.map((c) => [c.kind, c.user, c.subject]), [["update", p1, ADMIN], ["signOut", p1, ADMIN]]);
  eq("changing nothing else about the account", Object.keys(ch[0].body).sort(), ["changePasswordAtNextLogin", "password"]);
  check("shows the password Google was given", reset1.length === 16 && reset1 === ch[0].body.password && ch[0].body.changePasswordAtNextLogin === true);
  check("says they were signed out", (await page.getByTestId("password-reset-result").innerText()).includes("also signed out everywhere"));
  await page.screenshot({ path: path.join(shotsDir, "13-password-reset.png"), fullPage: true });

  await control("/__settings?failSignOut=true");
  await resetOne(p2, { signOut: true });
  await page.getByTestId("password-reset-result").filter({ hasText: p2 }).waitFor({ timeout: 30_000 });
  const reset2 = (await page.getByTestId("password-reset-password").innerText()).trim();
  ch = (await control("/__changes?clear=true")).changes;
  const failedText = await page.getByTestId("password-reset-result").innerText();
  check("when signing out fails, the new password is still handed over", reset2 === ch[0].body.password && reset2 !== reset1, failedText);
  check("and the failure is spelled out", failedText.includes("signing them out failed") && failedText.includes("Devices already signed in still"), failedText);
  await control("/__settings?failSignOut=false");

  await resetOne(p1);
  await page.getByTestId("password-reset-result").filter({ hasText: p1 }).waitFor({ timeout: 30_000 });
  ch = (await control("/__changes?clear=true")).changes;
  eq("without the tick, nobody is signed out", ch.map((c) => c.kind), ["update"]);
  check("the result doesn't claim otherwise", !(await page.getByTestId("password-reset-result").innerText()).includes("signed out"));
  const reset3 = (await page.getByTestId("password-reset-password").innerText()).trim();

  await resetOne(ADMIN);
  await dialog().getByRole("alert").waitFor();
  check("refuses the admin account Open Admin acts as", (await dialog().getByRole("alert").innerText()).includes("is the admin account Open Admin acts as"));
  await dialog().getByRole("button", { name: "Cancel" }).click();
  await resetOne(suspendedPerson);
  await dialog().getByRole("alert").waitFor();
  check("refuses a suspended account, and says why", (await dialog().getByRole("alert").innerText()).includes("is suspended"));
  await dialog().getByRole("button", { name: "Cancel" }).click();
  await resetOne("nobody.here@example.com");
  await dialog().getByRole("alert").waitFor();
  check("says when there is no such account, in plain words", (await dialog().getByRole("alert").innerText()).includes("There is no account with the address nobody.here@example.com."), await dialog().getByRole("alert").innerText());
  await dialog().getByRole("button", { name: "Cancel" }).click();
  eq("none of those changed anything", (await control("/__changes?clear=true")).changes, []);
  const r401 = await post("/api/admin/user/password-reset", { user: p1 });
  eq("the server refuses a reset without the typed confirmation", r401.status, 400);
  const resets = readAudit().filter((a) => a.action === "user.password_reset");
  eq("every reset and refusal is in the audit log", resets.map((a) => a.outcome), ["success", "success", "success", "error", "error", "error", "error"]);
  eq("with whether the sign-out worked", resets.slice(0, 3).map((a) => [a.params.user, a.params.signedOut ?? null]), [[p1, true], [p2, false], [p1, null]]);
  check("no password is in the audit log", [shown, reset1, reset2, reset3].every((pw) => !auditText().includes(pw)));
  check("nor in anything the app printed", [reset1, reset2, reset3].every((pw) => !app.output().includes(pw)));

  // ------------------------------------------------------------ Bulk Operations
  console.log("\nBulk Operations: the new operations");
  await control("/__tenant");
  await control("/__changes?clear=true");
  const auditBeforeBulk = readAudit().length;
  await page.goto(`${BASE}/bulk`);
  const bulkCard = () => page.locator("[data-slot='card']", { hasText: "Preview & Run" });
  const bulkSummary = async () => (await bulkCard().locator("[data-slot='card-description']").innerText()).trim();
  const pickOperation = async (name) => {
    await dialog().waitFor({ state: "hidden" });
    await page.getByRole("combobox", { name: "Bulk operation" }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  const preview = async (csv) => {
    // Clear first and wait for the old preview to go, so the summary read
    // below is of these rows and not the last operation's.
    await page.fill("#csv-input", "");
    await bulkCard().waitFor({ state: "hidden" });
    await page.fill("#csv-input", csv);
    await page.waitForFunction(() => [...document.querySelectorAll("[data-slot='card-description']")].some((e) => /ready to run/.test(e.textContent ?? "")));
    return bulkSummary();
  };
  const startRun = async () => bulkCard().getByRole("button", { name: /^Run \d+ rows?$/ }).click();
  const finished = async () => {
    await page.waitForFunction(() => {
      const card = [...document.querySelectorAll("[data-slot='card']")].find((c) => /Preview & Run/.test(c.textContent ?? ""));
      return card && /succeeded/.test(card.textContent ?? "") && ![...card.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Cancel");
    }, null, { timeout: 60_000 });
    return bulkSummary();
  };
  const [b1, b2, b3, b4, b5, b6] = activePeople.slice(2);
  await page.getByRole("combobox", { name: "Bulk operation" }).click();
  const operations = (await page.getByRole("option").allInnerTexts()).map((t) => t.trim());
  await page.keyboard.press("Escape");
  eq("offers the eight operations", operations, ["Add email delegate", "Remove email delegate", "Set up email forwarding", "Add group member", "Remove group member", "Share a calendar", "Suspend accounts", "Re-enable accounts"]);

  await pickOperation("Add group member");
  let ready = await preview(`group,member,role\nall-staff@example.com,${b1}\nall-staff@example.com,${b2},manager\nall-staff@example.com,${b1}\nnope@example.com,${b3}\nall-staff@example.com,${b4},boss\nall-staff@example.com,user001@example.com`);
  eq("counts what will run and what won't, skipping the header", ready, "4 rows ready to run · 2 invalid (will be skipped)");
  const previewText = await bulkCard().innerText();
  check("says why each skipped row is skipped", previewText.includes("same as an earlier row") && previewText.includes("role must be one of: MEMBER, MANAGER, OWNER"), previewText);
  await startRun();
  check("the dialog carries the warning about roles", (await dialog().innerText()).includes("can demote an owner or manager"));
  await confirmWith("RUN 4", "Start run");
  eq("runs the good rows and reports the bad one", await finished(), "3 succeeded · 1 failed · 2 skipped (invalid)");
  let state = await control("/__changes?clear=true");
  eq("adds the members with the roles asked for", state.changes.filter((c) => c.kind === "groupAdd").map((c) => [c.group, c.member, c.role]), [["all-staff@example.com", b1, "MEMBER"], ["all-staff@example.com", b2, "MANAGER"]]);
  eq("a row without a role leaves an existing owner an owner", [state.groups["all-staff@example.com"]["user001@example.com"], state.changes.filter((c) => c.kind === "groupRole").length], ["OWNER", 0]);
  check("names the group that doesn't exist", /not found/i.test(await bulkCard().locator("div.rounded-lg", { hasText: "nope@example.com" }).innerText()), await bulkCard().locator("div.rounded-lg", { hasText: "nope@example.com" }).innerText());
  await page.screenshot({ path: path.join(shotsDir, "14-bulk-groups.png"), fullPage: true });

  await pickOperation("Share a calendar");
  ready = await preview(`${b1},${b2}\n${b1},${b3},WRITER\n${b1},${b4},owner`);
  eq("calendar sharing refuses ownership in the preview", ready, "2 rows ready to run · 1 invalid (will be skipped)");
  check("and says where to do that instead", (await bulkCard().innerText()).includes("use the Calendar Delegation page"));
  await startRun();
  await confirmWith("RUN 2", "Start run");
  eq("shares the calendars", await finished(), "2 succeeded · 0 failed · 1 skipped (invalid)");
  state = await control("/__changes?clear=true");
  eq("as the calendar's owner, read-only unless told otherwise", state.changes.map((c) => [c.kind, c.subject, c.calendar, c.with, c.role]), [["calendarShare", b1, b1, b2, "reader"], ["calendarShare", b1, b1, b3, "writer"]]);

  await pickOperation("Suspend accounts");
  ready = await preview(`user\n${b5}\n${b6}\n${ADMIN}\n${b5},${b6}`);
  eq("suspend takes one column and refuses a row with two", ready, "3 rows ready to run · 1 invalid (will be skipped)");
  await startRun();
  const suspendDialog = await dialog().innerText();
  check("the dialog warns that the list is locked out", suspendDialog.includes("locked out") && suspendDialog.includes("SUSPEND 3"), suspendDialog);
  await dialog().locator("#confirm-phrase").fill("RUN 3");
  check("a generic RUN doesn't start a suspension", await dialog().getByRole("button", { name: "Start run" }).isDisabled());
  await confirmWith("SUSPEND 3", "Start run");
  eq("suspends the two people and refuses the admin", await finished(), "2 succeeded · 1 failed · 1 skipped (invalid)");
  state = await control("/__changes?clear=true");
  eq("only those two were changed, and only their suspension", state.changes.map((c) => [c.kind, c.user, c.body]), [["update", b5, { suspended: true }], ["update", b6, { suspended: true }]]);
  check("the admin is still active", !state.suspended.includes(ADMIN) && state.suspended.includes(b5) && state.suspended.includes(b6));
  check("the admin's row explains the refusal", /lock Open Admin out/.test(await bulkCard().locator("div.rounded-lg", { hasText: ADMIN }).innerText()), await bulkCard().locator("div.rounded-lg", { hasText: ADMIN }).innerText());
  await page.screenshot({ path: path.join(shotsDir, "15-bulk-suspend.png"), fullPage: true });

  await pickOperation("Re-enable accounts");
  ready = await preview(`${b5}\n${b6}`);
  await startRun();
  await confirmWith("ENABLE 2", "Start run");
  eq("the same file re-enables them", await finished(), "2 succeeded · 0 failed · 0 skipped (invalid)");
  state = await control("/__changes?clear=true");
  check("both can sign in again", !state.suspended.includes(b5) && !state.suspended.includes(b6));

  await pickOperation("Remove group member");
  ready = await preview(`all-staff@example.com,${b1}\nsales@example.com,${b1}`);
  await startRun();
  await confirmWith("REMOVE 2", "Start run");
  await finished();
  state = await control("/__changes?clear=true");
  eq("removes the member from the group they were in", [state.changes.filter((c) => c.kind === "groupRemove").map((c) => [c.group, c.member]), b1 in state.groups["all-staff@example.com"], b2 in state.groups["all-staff@example.com"]], [[["all-staff@example.com", b1]], false, true]);
  const bulkAudit = readAudit().slice(auditBeforeBulk).filter((a) => ["groups.member_add", "groups.member_remove", "calendar_delegation.add", "offboarding.suspend", "user.unsuspend"].includes(a.action));
  const tally = (action, outcome) => bulkAudit.filter((a) => a.action === action && a.outcome === outcome).length;
  eq("every row is in the audit log on its own", [tally("groups.member_add", "success"), tally("groups.member_add", "error"), tally("calendar_delegation.add", "success"), tally("offboarding.suspend", "success"), tally("offboarding.suspend", "error"), tally("user.unsuspend", "success"), tally("groups.member_remove", "success")], [3, 1, 2, 2, 1, 2, 2]);

  // ------------------------------------------- what the server insists on itself
  console.log("\nConfirmations the server insists on, whatever the page sends");
  await control("/__changes?clear=true");
  await control("/__log?clear=true");
  const api = async (method, route, body) => {
    const res = await fetch(`${BASE}${route}`, {
      method,
      headers: { "content-type": "application/json", origin: BASE, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  let refused = await api("POST", "/api/admin/groups/members", { group: "sales@example.com", member: b3, role: "OWNER" });
  eq("making someone a group owner without typing their address", refused.status, 400);
  refused = await api("POST", "/api/admin/groups/members", { group: "sales@example.com", member: "partner@outside.example" });
  check("adding someone outside the organisation without confirming the outside address", refused.status === 400 && /outside/.test(refused.body?.error ?? ""), JSON.stringify(refused));
  refused = await api("POST", "/api/gws/calendar-delegation", { calendarId: b1, delegateEmail: b2, role: "owner" });
  eq("making someone a calendar owner without typing their address", refused.status, 400);
  refused = await api("POST", "/api/admin/mailbox-import/labels", { user: b1, labels: [{ id: "Label_1", name: "Projects", type: "user" }] });
  eq("creating import labels without typing the mailbox's address", refused.status, 400);
  refused = await api("GET", "/api/admin/preflight-scopes");
  eq("a scope check that doesn't say which tenant", refused.status, 400);
  check("none of those reached Google with a change", (await control("/__log?clear=true")).every((x) => x.method === "GET"));
  const owner = await api("POST", "/api/admin/groups/members", { group: "sales@example.com", member: b3, role: "OWNER", confirm: b3 });
  state = await control("/__changes?clear=true");
  eq("with the address typed, the owner is added", [owner.status, state.groups["sales@example.com"][b3]], [200, "OWNER"]);

  // ------------------------------------------------------------------ Licences
  console.log("\nLicences");
  await control("/__tenant");
  await control("/__changes?clear=true");
  const LICENSING = "https://www.googleapis.com/auth/apps.licensing";
  const licDirectory = buildTenant();
  const lic = buildLicenses(licDirectory);
  const personByEmail = new Map(licDirectory.map((e) => [e.user.primaryEmail, e.user]));
  const idleFor = (u) => Math.floor((NOW - Date.parse(u.lastLoginTime === "1970-01-01T00:00:00.000Z" ? u.creationTime : u.lastLoginTime)) / 86_400_000);
  const reclaim = lic.filter(([user, sku]) => {
    const u = personByEmail.get(user);
    if (sku.productId === "101034" || u.archived) return false;
    return u.suspended || idleFor(u) >= 180;
  });
  const unlicensed = licDirectory.map((e) => e.user).filter((u) => !u.suspended && !u.archived && !lic.some(([holder]) => holder === u.primaryEmail)).map((u) => u.primaryEmail);
  const held = (sku) => lic.filter(([, s]) => s === sku).length;
  const apiCall = (method, p, body) => fetch(`${BASE}${p}`, { method, headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) });

  await control("/__settings?refuseLicensing=true&licensePageSize=40");
  await page.goto(`${BASE}/licenses`);
  await page.getByRole("button", { name: "Check licences" }).click();
  const setupBox = page.getByTestId("licenses-setup");
  await setupBox.waitFor({ timeout: 30_000 });
  let setupText = await setupBox.innerText();
  check("a tenant that hasn't authorised the permission is told the step to take", setupText.includes("hasn't been allowed to manage licences yet") && setupText.includes(LICENSING) && setupText.includes("Manage Domain Wide Delegation"), setupText);
  eq("and is shown no results", await page.getByTestId("licenses-skus").count(), 0);
  await page.screenshot({ path: path.join(shotsDir, "16-licences-setup.png"), fullPage: true });
  await control("/__settings?refuseLicensing=false&licensingApiOff=true");
  await page.getByRole("button", { name: "Check again" }).click();
  await setupBox.filter({ hasText: "switched off" }).waitFor({ timeout: 30_000 });
  setupText = await setupBox.innerText();
  check("a project with the API switched off is told that step instead", setupText.includes("Enterprise License Manager API") && setupText.includes("press Enable") && !setupText.includes("Manage Domain Wide Delegation"), setupText);
  await control("/__settings?licensingApiOff=false");

  await control("/__log?clear=true");
  await page.getByRole("button", { name: "Check again" }).click();
  const licStatus = page.getByTestId("licenses-status");
  await licStatus.filter({ hasText: "Complete." }).waitFor({ timeout: 60_000 });
  eq("reads every licence and every account", (await licStatus.innerText()).trim(), `Complete. ${lic.length} licences across ${licDirectory.length} accounts.`);
  eq("the setup notice is gone once it works", await setupBox.count(), 0);
  const skuCard = page.getByTestId("licenses-skus");
  const skuRow = (sku) => skuCard.locator("div.rounded-lg", { has: page.getByText(sku.skuName, { exact: true }) });
  for (const [key, sku] of Object.entries(SKUS)) {
    check(`counts the holders of ${key}`, (await skuRow(sku).innerText()).includes(`${held(sku)} assigned`), await skuRow(sku).innerText());
  }
  const llog = (await control("/__log?clear=true")).filter((x) => x.path.startsWith("/apps/licensing/"));
  check("every licensing request was a read, as the admin, with only the licensing permission", llog.length > 0 && llog.every((x) => x.method === "GET" && x.subject === ADMIN && x.scopes.length === 1 && x.scopes[0] === LICENSING));
  eq("long lists are read page by page", llog.filter((x) => x.path.endsWith("/Google-Apps/users")).length, Math.ceil(lic.filter(([, s]) => s.productId === "Google-Apps").length / 40));
  eq("asks about each product once more than it has pages, and no others", [...new Set(llog.map((x) => x.path.split("/")[5]))].sort(), ["101001", "101005", "101031", "101033", "101034", "101037", "Google-Apps"]);

  const recCard = page.getByTestId("licenses-reclaimable");
  const recDesc = await recCard.locator("[data-slot='card-description']").innerText();
  check("counts the licences that are probably unused", recDesc.startsWith(`${reclaim.length} licences on accounts that are suspended`), recDesc);
  eq("and lists each", await recCard.locator("div.rounded-lg").count(), reclaim.length);
  const recRow = (user) => recCard.locator("div.rounded-lg", { hasText: user });
  check("says an account is suspended", (await recRow("user010@example.com").innerText()).includes("Suspended"));
  check("says how long since the last sign-in", (await recRow("user023@example.com").innerText()).includes("No sign-in for 400 days"), await recRow("user023@example.com").innerText());
  check("says when an account was never used", (await recRow("user029@example.com").innerText()).includes("Never signed in (created 500 days ago)"), await recRow("user029@example.com").innerText());
  eq("lists both licences of a suspended account that has two", await recRow("user020@example.com").count(), 2);
  eq("never suggests taking the archived account's licence", await recRow("user055@example.com").count(), 0);
  check("marks how many of a type may be unused", (await skuRow(SKUS.voice).innerText()).includes(`${reclaim.filter(([, s]) => s === SKUS.voice).length} may be unused`), await skuRow(SKUS.voice).innerText());
  const unCard = page.getByTestId("licenses-unlicensed");
  eq("lists the active accounts that hold no licence", await unCard.locator("div.rounded-lg p.font-medium").allInnerTexts(), unlicensed);
  await page.screenshot({ path: path.join(shotsDir, "17-licences.png"), fullPage: true });

  const victim = "user010@example.com";
  await recRow(victim).getByRole("button", { name: "Remove licence" }).click();
  const removeDialog = await dialog().innerText();
  check("the removal dialog carries Google's warning about data", removeDialog.includes("can lose the data") && removeDialog.includes(victim) && removeDialog.includes(SKUS.standard.skuName), removeDialog);
  check("nothing can be removed before the address is typed", await dialog().getByRole("button", { name: "Remove licence" }).isDisabled());
  await confirmWith(victim, "Remove licence");
  await dialog().waitFor({ state: "hidden" });
  ch = (await control("/__changes?clear=true")).changes;
  eq("removes exactly that licence, as the admin, with the licensing permission", ch.map((c) => [c.kind, c.user, c.skuId, c.subject, c.scopes]), [["licenseRemove", victim, SKUS.standard.skuId, ADMIN, [LICENSING]]]);
  eq("the row goes and the counts follow, without reading everything again", [await recRow(victim).count(), await recCard.locator("div.rounded-lg").count(), (await skuRow(SKUS.standard).innerText()).includes(`${held(SKUS.standard) - 1} assigned`)], [0, reclaim.length - 1, true]);
  check("says what was done", (await page.getByRole("alert").first().innerText()).includes(`Removed ${SKUS.standard.skuName} from ${victim}.`));

  // Someone else removes a licence while this page is open.
  await control("/__unlicense?user=user030@example.com");
  await recRow("user030@example.com").getByRole("button", { name: "Remove licence" }).click();
  await confirmWith("user030@example.com", "Remove licence");
  await dialog().getByRole("alert").waitFor();
  check("refuses to remove what the account no longer holds", (await dialog().getByRole("alert").innerText()).includes("doesn't hold that licence any more"));
  await dialog().getByRole("button", { name: "Cancel" }).click();
  let lr = await apiCall("DELETE", "/api/admin/licenses", { user: ADMIN, productId: "Google-Apps", skuId: SKUS.plus.skuId, confirm: ADMIN });
  check("the server refuses to take the admin's own licence", lr.status === 400 && (await lr.json()).error.includes("acts as"));
  lr = await apiCall("DELETE", "/api/admin/licenses", { user: "user040@example.com", productId: "Google-Apps", skuId: SKUS.plus.skuId });
  eq("and a removal without the typed confirmation", lr.status, 400);
  lr = await apiCall("DELETE", "/api/admin/licenses", { user: "user040@example.com", productId: "Something-Else", skuId: SKUS.plus.skuId, confirm: "user040@example.com" });
  eq("and a product it doesn't ask about", lr.status, 400);
  eq("none of which removed anything", (await control("/__changes?clear=true")).changes, []);

  const newcomer = unlicensed[0];
  await unCard.locator("div.rounded-lg", { hasText: newcomer }).getByRole("button", { name: "Assign a licence" }).click();
  eq("the assign form is filled in from the row", await page.inputValue("#assignUser"), newcomer);
  const assignCard = page.getByTestId("licenses-assign");
  check("and waits for a licence to be chosen", await assignCard.getByRole("button", { name: "Review & assign" }).isDisabled());
  const pickLicence = async (sku) => {
    await page.getByRole("combobox", { name: "Licence to assign" }).click();
    await page.getByRole("option", { name: sku.skuName, exact: true }).click();
  };
  await pickLicence(SKUS.plus);
  check("the closed box shows the licence's name", (await page.getByRole("combobox", { name: "Licence to assign" }).innerText()).includes(SKUS.plus.skuName));
  await assignCard.getByRole("button", { name: "Review & assign" }).click();
  const assignDialog = await dialog().innerText();
  check("the assign dialog says it may be billed", assignDialog.includes(newcomer) && assignDialog.includes(SKUS.plus.skuName) && assignDialog.includes("bills for it"), assignDialog);
  await confirmWith(newcomer, "Assign licence");
  await dialog().waitFor({ state: "hidden" });
  ch = (await control("/__changes?clear=true")).changes;
  eq("assigns that licence to that account", ch.map((c) => [c.kind, c.user, c.skuId, c.subject, c.scopes]), [["licenseAssign", newcomer, SKUS.plus.skuId, ADMIN, [LICENSING]]]);
  eq("the account leaves the unlicensed list and the count goes up", [await unCard.locator("div.rounded-lg", { hasText: newcomer }).count(), (await skuRow(SKUS.plus).innerText()).includes(`${held(SKUS.plus) + 1} assigned`)], [0, true]);
  await page.fill("#assignUser", "user001@example.com");
  await assignCard.getByRole("button", { name: "Review & assign" }).click();
  await confirmWith("user001@example.com", "Assign licence");
  await dialog().getByRole("alert").waitFor();
  check("shows Google's refusal when the account already has one", (await dialog().getByRole("alert").innerText()).includes("already has a license"));
  await dialog().getByRole("button", { name: "Cancel" }).click();

  const [licCsv] = await Promise.all([page.waitForEvent("download"), page.getByTestId("licenses-card").getByRole("button", { name: "Export CSV" }).click()]);
  const licCsvPath = path.join(workDir, "licences.csv");
  await licCsv.saveAs(licCsvPath);
  const licCsvRows = fs.readFileSync(licCsvPath, "utf-8").split("\n");
  eq("the export has a row per licence", licCsvRows.length - 1, lic.length);
  check("with the account's state and why it may be unused", licCsvRows.some((l) => l.includes('"user020@example.com"') && l.includes('"suspended"') && l.includes('"Suspended"')) && licCsvRows.some((l) => l.includes('"user023@example.com"') && l.includes('"active"') && l.includes('"No sign-in for 400 days"')), licCsvRows.slice(0, 3).join(" | "));

  await control("/__settings?failVoice=true");
  await page.getByRole("button", { name: "Check again" }).click();
  await licStatus.filter({ hasText: "Complete." }).waitFor({ timeout: 60_000 });
  check("names a product that could not be read", (await page.getByTestId("licenses-failed-products").innerText()).includes("Google Voice"), await page.getByTestId("licenses-failed-products").innerText());
  eq("and then claims nobody is without a licence", await unCard.count(), 0);
  await control("/__settings?failVoice=false&licensePageSize=500");
  const licAudit = readAudit().filter((a) => a.action.startsWith("licenses."));
  eq("every change and refusal is in the audit log", [licAudit.filter((a) => a.action === "licenses.remove" && a.outcome === "success").map((a) => a.params), licAudit.filter((a) => a.action === "licenses.remove" && a.outcome === "error").length, licAudit.filter((a) => a.action === "licenses.assign" && a.outcome === "success").map((a) => a.params.user), licAudit.filter((a) => a.action === "licenses.assign" && a.outcome === "error").length], [[{ user: victim, productId: "Google-Apps", skuId: SKUS.standard.skuId, skuName: SKUS.standard.skuName }], 4, [newcomer], 1]);

  // ---------------------------------------------------------------- Signatures
  console.log("\nEmail Signatures");
  await control("/__tenant");
  await control("/__changes?clear=true");
  const BASIC = "https://www.googleapis.com/auth/gmail.settings.basic";
  await page.goto(`${BASE}/signatures`);
  const tpl = page.locator("#signature-template");
  const previewCard = page.getByTestId("signature-preview-card");
  const applyCard = page.getByTestId("signature-apply-card");
  eq("starts with a template that works", await tpl.inputValue(), "**{{name}}**\n{{title}}\n{{department}}\n{{phone}}\n{{email}}");
  await tpl.fill("{{nmae}}");
  check("refuses a misspelt field, by name", (await page.getByTestId("signature-template-problem").innerText()).includes("{{nmae}} isn't a field"));
  await page.fill("#previewUser", "user002@example.com");
  check("and won't preview or apply while the template is wrong", (await previewCard.getByRole("button", { name: "Preview" }).isDisabled()) && (await applyCard.getByRole("button", { name: /Review & apply/ }).isDisabled()));
  await tpl.fill("Regards, ");
  await page.getByRole("button", { name: "+ First name" }).click();
  eq("a field button puts the field in", await tpl.inputValue(), "Regards, {{firstName}}");
  const TEMPLATE = "**{{name}}**\n{{title}}, {{department}}\nTel: {{phone}}\n{{email}}\nExample Corp · https://example.com";
  await tpl.fill(TEMPLATE);

  const previewFor = async (user) => {
    await page.fill("#previewUser", user);
    await previewCard.getByRole("button", { name: "Preview" }).click();
    await page.waitForFunction((u) => {
      const card = document.querySelector("[data-testid='signature-preview-card']");
      return !card?.querySelector("svg.animate-spin") && (card?.querySelector("[data-testid='signature-new']")?.textContent?.includes(u) || card?.querySelector("[role='alert']"));
    }, user, { timeout: 30_000 });
  };
  await previewFor("user002@example.com");
  eq("fills the template in from the person's profile", (await page.getByTestId("signature-new").innerText()).trim(), "User 2\nRole 2, Operations\nTel: +44 20 7946 0002\nuser002@example.com\nExample Corp · https://example.com");
  check("shows that they have no signature now", (await page.getByTestId("signature-current").innerText()).includes("(no signature)"));
  await previewFor("user003@example.com");
  eq("leaves out the lines this person has nothing for", (await page.getByTestId("signature-new").innerText()).trim(), "User 3\nuser003@example.com\nExample Corp · https://example.com");
  check("and says what the directory is missing", (await page.getByTestId("signature-missing").innerText()).includes("has no job title, department, phone in the directory"), await page.getByTestId("signature-missing").innerText());
  await previewFor("user001@example.com");
  eq("shows the signature they have now, as plain text", (await page.getByTestId("signature-current").innerText()).trim(), "Sent from my phone");
  await page.screenshot({ path: path.join(shotsDir, "18-signatures-preview.png"), fullPage: true });
  await previewFor("user010@example.com");
  check("says why a suspended account can't be previewed", (await previewCard.getByRole("alert").innerText()).includes("is suspended"));
  eq("previewing changed nothing", (await control("/__changes")).changes, []);

  await page.fill("#signature-recipients", "user001@example.com\nuser002@example.com, user003@example.com\nuser010@example.com\nnobody@example.com\nUSER002@example.com\nnot an address");
  check("names a line that isn't an address", (await page.getByTestId("signature-recipients-problem").innerText()).includes("not an address"));
  await page.fill("#signature-recipients", "user001@example.com\nuser002@example.com, user003@example.com\nuser010@example.com\nnobody@example.com\nUSER002@example.com");
  const applyButton = applyCard.getByRole("button", { name: /Review & apply/ });
  eq("counts each mailbox once", (await applyButton.innerText()).trim(), "Review & apply to 5 mailboxes");
  await applyButton.click();
  const sigDialog = await dialog().innerText();
  check("the dialog says signatures are overwritten", sigDialog.includes("overwritten") && sigDialog.includes("APPLY 5"), sigDialog);
  check("nothing starts before the phrase is typed", await dialog().getByRole("button", { name: "Replace signatures" }).isDisabled());
  await confirmWith("APPLY 5", "Replace signatures");
  const sigStatus = page.getByTestId("signature-status");
  await sigStatus.filter({ hasText: /^Done\./ }).waitFor({ timeout: 60_000 });
  eq("replaces the signatures it can and reports the rest", (await sigStatus.innerText()).trim(), "Done. 3 replaced · 0 already had it · 2 failed");
  ch = (await control("/__changes?clear=true")).changes;
  // Mailboxes are done a few at a time, so they finish in no fixed order.
  eq("each mailbox is opened as its owner, with the basic settings permission, on its own address", ch.map((c) => [c.kind, c.subject, c.address, c.scopes]).sort((a, b) => a[1].localeCompare(b[1])), ["user001", "user002", "user003"].map((u) => ["signature", `${u}@example.com`, `${u}@example.com`, [BASIC]]));
  eq("and is given exactly what the preview showed", ch.find((c) => c.address === "user002@example.com")?.signature, '<div dir="ltr"><b>User 2</b><br>Role 2, Operations<br>Tel: +44 20 7946 0002<br><a href="mailto:user002@example.com">user002@example.com</a><br>Example Corp · <a href="https://example.com">https://example.com</a></div>');
  const sigResults = page.getByTestId("signature-results");
  check("says why the suspended account was skipped", (await sigResults.locator("div.rounded-lg", { hasText: "user010@example.com" }).innerText()).includes("is suspended"));
  check("and that the other address reaches no account, in plain words", (await sigResults.locator("div.rounded-lg", { hasText: "nobody@example.com" }).innerText()).includes("There is no account with the address nobody@example.com."));
  await page.screenshot({ path: path.join(shotsDir, "19-signatures-applied.png"), fullPage: true });
  const [sigCsv] = await Promise.all([page.waitForEvent("download"), applyCard.getByRole("button", { name: "Export results CSV" }).click()]);
  const sigCsvPath = path.join(workDir, "signatures.csv");
  await sigCsv.saveAs(sigCsvPath);
  const sigCsvText = fs.readFileSync(sigCsvPath, "utf-8");
  check("the export keeps the signature that was replaced", sigCsvText.includes('"user001@example.com","replaced","","<div>Sent from my <b>phone</b></div>"'), sigCsvText.split("\n").slice(0, 3).join(" | "));

  await applyButton.click();
  await confirmWith("APPLY 5", "Replace signatures");
  await sigStatus.filter({ hasText: "3 already had it" }).waitFor({ timeout: 60_000 });
  eq("a second run finds nothing to change", (await sigStatus.innerText()).trim(), "Done. 0 replaced · 3 already had it · 2 failed");
  eq("and writes nothing", (await control("/__changes?clear=true")).changes, []);

  await applyCard.getByRole("button", { name: "Use everyone with a mailbox" }).click();
  const withMailbox = buildTenant().map((e) => e.user).filter((u) => !u.suspended && !u.archived && u.isMailboxSetup !== false).map((u) => u.primaryEmail);
  await applyCard.getByRole("alert").filter({ hasText: "Added" }).waitFor({ timeout: 30_000 });
  eq("fills in everyone who has a mailbox, and only them", (await page.inputValue("#signature-recipients")).split("\n"), withMailbox);
  check("and says who was left out", (await applyCard.getByRole("alert").innerText()).includes(`Added ${withMailbox.length} mailboxes. Left out ${131 - withMailbox.length} that are suspended, archived or without Gmail.`), await applyCard.getByRole("alert").innerText());

  const sr = await post("/api/admin/signatures", { user: "user004@example.com", template: TEMPLATE });
  eq("the server refuses to set a signature without the typed confirmation", sr.status, 400);
  const sigAudit = readAudit().filter((a) => a.action === "signatures.apply");
  eq("every mailbox is in the audit log on its own", [sigAudit.filter((a) => a.outcome === "success" && a.params.changed).length, sigAudit.filter((a) => a.outcome === "success" && !a.params.changed).length, sigAudit.filter((a) => a.outcome === "error").length], [3, 3, 5]);
  check("the log records who, not the template", !auditText().includes("Example Corp ·"));

  // ------------------------------------------------------------------- Updates
  console.log("\nUpdate notice");
  const RELEASES = "https://github.com/Michael-Civitillo/google-workspace-ai-toolbox/releases/latest";
  const builtVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")).version;
  const appConfig = () => JSON.parse(fs.readFileSync(path.join(workDir, "root", "data", "app-config.json"), "utf-8"));
  eq("until it is switched on, nobody is asked about releases", (await control("/__releasehits")).length, 0);
  await page.goto(`${BASE}/settings`);
  const updates = page.getByTestId("update-settings");
  await page.getByTestId("running-version").filter({ hasText: /\d/ }).waitFor();
  eq("shows the version that is running", (await page.getByTestId("running-version").innerText()).trim(), builtVersion);
  const toggle = page.getByTestId("update-check-toggle");
  eq("the check is off to begin with", [await toggle.isChecked(), await page.getByTestId("update-notice").count(), await page.getByTestId("update-status").count()], [false, 0, 0]);
  check("and says exactly what switching it on does", (await updates.innerText()).includes("says nothing about your organisation") && (await updates.innerText()).includes("Nothing is downloaded or installed"));

  await control(`/__setrelease?tag=v99.0.0&html=${encodeURIComponent("https://evil.example/open-admin.exe")}`);
  await toggle.check();
  const updateStatus = page.getByTestId("update-status");
  await updateStatus.filter({ hasText: "99.0.0" }).waitFor({ timeout: 30_000 });
  check("once on, it says a newer version is out", (await updateStatus.innerText()).includes("Version 99.0.0 is out."));
  eq("and links only to the project's own release page, whatever the server said", await updateStatus.getByRole("link").getAttribute("href"), RELEASES);
  const notice = page.getByTestId("update-notice");
  await notice.waitFor({ timeout: 15_000 });
  eq("the menu shows it too, with the same link, opening in a new tab", [(await notice.innerText()).includes("Version 99.0.0 is out"), (await notice.innerText()).includes(`You have ${builtVersion}`), await notice.getAttribute("href"), await notice.getAttribute("target"), await notice.getAttribute("rel")], [true, true, RELEASES, "_blank", "noopener noreferrer"]);
  await page.screenshot({ path: path.join(shotsDir, "20-updates.png"), fullPage: true });
  let hits = await control("/__releasehits");
  check("it asked once", hits.length === 1, String(hits.length));
  check("with a plain request that carries no cookie, no credentials and a generic name", hits[0].method === "GET" && hits[0].headers["user-agent"] === "open-admin-update-check" && !hits[0].headers.cookie && !hits[0].headers.authorization, JSON.stringify(hits[0].headers));
  eq("the setting is saved", appConfig().updateCheck, true);
  await page.goto(`${BASE}/`);
  await notice.waitFor({ timeout: 15_000 });
  await page.goto(`${BASE}/settings`);
  await updateStatus.waitFor();
  eq("moving between pages doesn't ask again", (await control("/__releasehits")).length, 1);

  await control(`/__setrelease?tag=v${builtVersion}`);
  await updateStatus.getByRole("button", { name: "Check now" }).click();
  await updateStatus.filter({ hasText: "You have the newest version" }).waitFor({ timeout: 30_000 });
  // The menu asks for the new answer itself; give it the moment that takes.
  await notice.waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
  eq("on the latest release, the notice goes away", [await notice.count(), (await control("/__releasehits")).length], [0, 2]);
  await control(`/__setrelease?status=500`);
  await updateStatus.getByRole("button", { name: "Check now" }).click();
  await updateStatus.filter({ hasText: "Could not check" }).waitFor({ timeout: 30_000 });
  check("a failed check says so, and shows no notice", (await updateStatus.innerText()).includes("The release server answered 500.") && (await notice.count()) === 0, await updateStatus.innerText());

  await control(`/__setrelease?tag=v99.0.0&status=200`);
  await toggle.uncheck();
  await updateStatus.waitFor({ state: "detached", timeout: 15_000 });
  const hitsWhenOff = (await control("/__releasehits")).length;
  await page.reload();
  await page.getByTestId("running-version").filter({ hasText: /\d/ }).waitFor();
  await page.goto(`${BASE}/`);
  await page.waitForLoadState("networkidle");
  eq("switched off again, it stops asking and shows nothing, even with a newer release out", [(await control("/__releasehits")).length, await notice.count(), appConfig().updateCheck], [hitsWhenOff, 0, false]);
  const ur = await post("/api/config/update", { check: true });
  eq("'check now' can't override the switch being off", [(await ur.json()).data.enabled, (await control("/__releasehits")).length], [false, hitsWhenOff]);
  eq("turning it on and off is in the audit log", readAudit().filter((a) => a.action === "config.update_check").map((a) => a.params.enabled), [true, false]);

  console.log("\nBrowser console");
  eq("no errors logged by the page", consoleErrors.filter((e) => !/502|499|Failed to load resource/.test(e)), []);
} catch (e) {
  stoppedEarly = true;
  console.log(`\nFAIL the run threw: ${e.stack ?? e}`);
  console.log(`--- the last of what the app printed ---\n${(app?.output() ?? "").split("\n").slice(-30).join("\n")}`);
} finally {
  await browser?.close();
  app?.stop();
  standIn?.stop();
}
console.log(
  `\ne2e: ${checks - failures}/${checks} checks passed` +
    (stoppedEarly ? " — the run stopped early, so the checks after that point never ran" : "")
);
const passed = failures === 0 && !stoppedEarly;
if (work.temporary && passed && !args.keep) {
  // Give the app a moment to let go of its files before they are removed.
  await sleep(500);
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} else {
  console.log(`The app's data, its audit log and the screenshots from this run are in ${workDir}`);
}
process.exit(passed ? 0 : 1);
