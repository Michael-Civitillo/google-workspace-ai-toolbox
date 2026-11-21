import puppeteer from "puppeteer";
import { mkdir, unlink } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const screenshotsDir = join(__dirname, "..", "docs", "screenshots");

const BASE_URL = process.env.SCREENSHOT_BASE_URL || "http://localhost:3000";
const PASSWORD = process.env.APP_PASSWORD || "";
const THEMES = (process.env.SCREENSHOT_THEMES || "light,dark").split(",");

// Every page in the sidebar, in sidebar order, so a page added to the app has an
// obvious place here. Three are deliberately absent: security-check.png and
// licenses.png show a finished scan, and signatures.png shows a preview. None
// of those can be produced by loading a URL, so they are captured separately
// (sample data) and left alone here.
const pages = [
  { name: "dashboard", path: "/", delay: 1500 },
  { name: "get-started", path: "/onboarding", delay: 1500 },
  { name: "email-delegation", path: "/email-delegation", delay: 500 },
  { name: "delegation-lookup", path: "/delegation-lookup", delay: 500 },
  { name: "calendar-delegation", path: "/calendar-delegation", delay: 500 },
  { name: "groups", path: "/groups", delay: 800 },
  { name: "email-transfer", path: "/email-transfer", delay: 500 },
  { name: "calendar-transfer", path: "/calendar-transfer", delay: 500 },
  { name: "drive-transfer", path: "/drive-transfer", delay: 500 },
  { name: "new-user", path: "/new-user", delay: 800 },
  { name: "domain-change", path: "/domain-change", delay: 500 },
  { name: "offboarding", path: "/offboarding", delay: 800 },
  { name: "bulk", path: "/bulk", delay: 500 },
  { name: "mailbox-export", path: "/mailbox-export", delay: 500 },
  { name: "mailbox-import", path: "/mailbox-import", delay: 500 },
  { name: "sharing-audit", path: "/sharing-audit", delay: 800 },
  { name: "audit", path: "/audit", delay: 800 },
  { name: "activity-reports", path: "/activity-reports", delay: 800 },
  { name: "audit-log", path: "/audit-log", delay: 800 },
  { name: "setup", path: "/setup", delay: 1500 },
  { name: "tenants", path: "/tenants", delay: 800 },
  { name: "sso", path: "/sso", delay: 800 },
  { name: "settings", path: "/settings", delay: 800 },
  { name: "login", path: "/login", delay: 800, skipLogin: true },
];

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle0" });
  await page.waitForSelector("input[type='password']", { timeout: 15000 });
  await page.type("input[type='password']", PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.click("button[type='submit']"),
  ]);
}

async function setTheme(page, theme) {
  // Drive the in-app toggle by writing localStorage and toggling the html
  // class directly. Reload so the inline anti-flash script picks up the new
  // value on first paint.
  await page.evaluate((t) => {
    localStorage.setItem("theme", t);
    document.documentElement.classList.toggle("dark", t === "dark");
  }, theme);
}

async function captureForTheme(browser, theme) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  if (PASSWORD) {
    console.log(`[${theme}] Logging in...`);
    await login(page);
  } else {
    // localStorage isn't accessible on about:blank — land on the app first.
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle0" });
  }

  await setTheme(page, theme);

  const suffix = theme === "dark" ? "-dark" : "";
  for (const { name, path, delay } of pages) {
    console.log(`[${theme}] Capturing ${name}...`);
    await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle0" });
    // Re-apply theme after navigation in case localStorage was cleared.
    await setTheme(page, theme);
    await new Promise((r) => setTimeout(r, delay));
    await page.addStyleTag({
      content: `
        nextjs-portal,
        [data-nextjs-toast],
        [data-nextjs-dev-tools-button],
        #__next-dev-tools-indicator { display: none !important; }
      `,
    });
    await page.screenshot({
      path: join(screenshotsDir, `${name}${suffix}.png`),
      fullPage: false,
    });
  }

  await page.close();
}

async function run() {
  await mkdir(screenshotsDir, { recursive: true });

  for (const stale of ["ai-command.png", "bulk-operations.png"]) {
    try { await unlink(join(screenshotsDir, stale)); } catch {}
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: process.env.PUPPETEER_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });

  for (const theme of THEMES) {
    await captureForTheme(browser, theme);
  }

  await browser.close();
  console.log("Done! Screenshots saved to docs/screenshots/");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
