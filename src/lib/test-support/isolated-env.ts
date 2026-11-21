/**
 * Import this FIRST in a test file that loads server modules which decide
 * file locations when they are loaded (the audit log, the single sign-on
 * config). It points the data folder at a fresh temporary directory and sets
 * the password and session secret, so a test never reads or writes the
 * developer's own files.
 *
 * Test-only: nothing in the app imports this file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "open-admin-test-"));
export const TEST_PASSWORD = "correct horse battery staple";

process.env.OPEN_ADMIN_DATA_DIR = TEST_DATA_DIR;
process.env.AUDIT_LOG_PATH = path.join(TEST_DATA_DIR, "audit.log");
process.env.SSO_CONFIG_PATH = path.join(TEST_DATA_DIR, "sso.json");
process.env.APP_PASSWORD = TEST_PASSWORD;
process.env.APP_SESSION_SECRET = "0123456789abcdef".repeat(4);
delete process.env.TRUSTED_PROXY;

process.on("exit", () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
