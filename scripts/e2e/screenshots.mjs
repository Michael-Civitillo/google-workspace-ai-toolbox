// The three README screenshots that scripts/screenshots.mjs can't take,
// because each needs something to have happened on the page first: a finished
// Security Check, a finished licence check, and a signature preview.
//
// Run it against the sample app, after `npm run screenshots` has done the rest:
//
//   node scripts/e2e/sample-app.mjs        (leave running)
//   node scripts/e2e/screenshots.mjs
//
// Writes security-check, licenses and signatures, each in light and dark.
import path from "node:path";
import { launchBrowser, parseArgs, repoRoot } from "./harness.mjs";

const USAGE = `Usage: node scripts/e2e/screenshots.mjs [options]

  --base <url>           where the sample app is (default http://localhost:3079)
  --password <text>      its sign-in password (default: sample-app-password)
  --out <folder>         where to write the images (default: docs/screenshots)`;

const args = parseArgs(
  process.argv.slice(2),
  { base: "http://localhost:3079", password: "sample-app-password", out: path.join(repoRoot, "docs", "screenshots") },
  USAGE
);
const base = args.base.replace(/\/+$/, "");
const outDir = path.resolve(args.out);

const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  // Start in light; each picture is then taken in light and, from the same
  // page with the same results on it, in dark. Running the page once per
  // theme made the two images show different scans.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("theme", "light");
    } catch {
      // The page falls back to light anyway.
    }
  });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill("input[type='password']", args.password);
  await page.click("button[type='submit']");
  await page.waitForURL(`${base}/`);

  // Each page opens in light (the init script above); the dark picture is
  // taken after the app's own switch, so everything that follows the theme
  // follows it.
  const shot = async (name) => {
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await page.getByRole("button", { name: "Switch to dark mode" }).click();
      // Park the pointer in the margin so nothing is drawn in its hover state.
      await page.mouse.move(1396, 4);
      await page.waitForTimeout(400);
      const file = `${name}${theme === "dark" ? "-dark" : ""}.png`;
      await page.screenshot({ path: path.join(outDir, file), fullPage: false });
      console.log(`captured ${file}`);
    }
  };

  await page.goto(`${base}/security-check`);
  await page.getByRole("button", { name: /^Run (check|again)$/ }).click();
  await page.getByRole("status").filter({ hasText: /Complete\./ }).waitFor({ timeout: 180_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("security-check");

  await page.goto(`${base}/licenses`);
  await page.getByRole("button", { name: /^Check (licences|again)$/ }).click();
  await page.getByTestId("licenses-status").filter({ hasText: "Complete." }).waitFor({ timeout: 120_000 });
  await shot("licenses");

  await page.goto(`${base}/signatures`);
  await page.fill("#previewUser", "user002@example.com");
  await page.getByTestId("signature-preview-card").getByRole("button", { name: "Preview" }).click();
  await page.getByTestId("signature-new").waitFor({ timeout: 60_000 });
  await page.fill("#signature-recipients", "user001@example.com\nuser002@example.com\nuser004@example.com");
  await shot("signatures");
  await context.close();
} finally {
  await browser.close();
}
