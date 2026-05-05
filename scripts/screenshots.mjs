import puppeteer from "puppeteer";
import { mkdir, unlink } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const screenshotsDir = join(__dirname, "..", "docs", "screenshots");

const BASE_URL = process.env.SCREENSHOT_BASE_URL || "http://localhost:3000";
const PASSWORD = process.env.APP_PASSWORD || "";
const THEMES = (process.env.SCREENSHOT_THEMES || "light,dark").split(",");

const pages = [
  { name: "dashboard", path: "/", delay: 1500 },
  { name: "audit", path: "/audit", delay: 800 },
  { name: "email-delegation", path: "/email-delegation", delay: 500 },
  { name: "calendar-delegation", path: "/calendar-delegation", delay: 500 },
  { name: "calendar-transfer", path: "/calendar-transfer", delay: 500 },
  { name: "email-transfer", path: "/email-transfer", delay: 500 },
  { name: "domain-change", path: "/domain-change", delay: 500 },
  { name: "offboarding", path: "/offboarding", delay: 800 },
  { name: "sharing-audit", path: "/sharing-audit", delay: 800 },
  { name: "tenants", path: "/tenants", delay: 800 },
  { name: "setup", path: "/setup", delay: 1500 },
  { name: "login", path: "/login", delay: 500, skipLogin: true },
];

async function captureForTheme(page, theme) {
  // Set the persisted theme so the inline anti-flash script in layout.tsx
  // reads it on first paint and doesn't briefly render the wrong mode.
  await page.evaluateOnNewDocument((t) => {
    try { localStorage.setItem("theme", t); } catch {}
  }, theme);

  if (PASSWORD) {
    console.log(`[${theme}] Logging in...`);
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle0" });
    await page.type("input[type='password']", PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0" }),
      page.click("button[type='submit']"),
    ]);
  }

  const suffix = theme === "dark" ? "-dark" : "";
  for (const { name, path, delay } of pages) {
    console.log(`[${theme}] Capturing ${name}...`);
    await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle0" });
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
}

async function run() {
  await mkdir(screenshotsDir, { recursive: true });

  // Clean up the orphaned screenshots from deleted pages so they don't
  // linger in the docs folder and confuse readers.
  for (const stale of ["ai-command.png", "bulk-operations.png"]) {
    try { await unlink(join(screenshotsDir, stale)); } catch {}
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: process.env.PUPPETEER_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });

  for (const theme of THEMES) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await captureForTheme(page, theme);
    await ctx.close();
  }

  await browser.close();
  console.log("Done! Screenshots saved to docs/screenshots/");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
