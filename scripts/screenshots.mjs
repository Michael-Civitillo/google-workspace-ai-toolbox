import puppeteer from "puppeteer";
import { mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const screenshotsDir = join(__dirname, "..", "docs", "screenshots");

const BASE_URL = process.env.SCREENSHOT_BASE_URL || "http://localhost:3000";
const PASSWORD = process.env.APP_PASSWORD || "";

const pages = [
  { name: "dashboard", path: "/", delay: 1500 },
  { name: "ai-command", path: "/ai-command", delay: 800 },
  { name: "bulk-operations", path: "/bulk-operations", delay: 800 },
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

async function run() {
  await mkdir(screenshotsDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: process.env.PUPPETEER_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  if (PASSWORD) {
    console.log("Logging in...");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle0" });
    await page.type("input[type='password']", PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0" }),
      page.click("button[type='submit']"),
    ]);
  } else {
    console.warn(
      "APP_PASSWORD not set — authenticated pages will redirect to /login."
    );
  }

  for (const { name, path, delay } of pages) {
    console.log(`Capturing ${name}...`);
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
      path: join(screenshotsDir, `${name}.png`),
      fullPage: false,
    });
  }

  await browser.close();
  console.log("Done! Screenshots saved to docs/screenshots/");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
