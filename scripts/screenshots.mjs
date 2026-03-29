import puppeteer from "puppeteer";
import { mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const screenshotsDir = join(__dirname, "..", "docs", "screenshots");

const pages = [
  { name: "dashboard", path: "/", delay: 1500 },
  { name: "email-delegation", path: "/email-delegation", delay: 500 },
  { name: "calendar-delegation", path: "/calendar-delegation", delay: 500 },
  { name: "calendar-transfer", path: "/calendar-transfer", delay: 500 },
  { name: "email-transfer", path: "/email-transfer", delay: 500 },
  { name: "setup", path: "/setup", delay: 1500 },
];

async function run() {
  await mkdir(screenshotsDir, { recursive: true });

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  for (const { name, path, delay } of pages) {
    console.log(`Capturing ${name}...`);
    await page.goto(`http://localhost:3000${path}`, {
      waitUntil: "networkidle0",
    });
    await new Promise((r) => setTimeout(r, delay));
    await page.screenshot({
      path: join(screenshotsDir, `${name}.png`),
      fullPage: false,
    });
  }

  await browser.close();
  console.log("Done! Screenshots saved to docs/screenshots/");
}

run().catch(console.error);
