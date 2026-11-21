/**
 * Where the session-signing key comes from.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";
import { resetSessionSecretForTests, resolveSessionSecret } from "./session-secret";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-secret-test-"));
const file = path.join(dir, "session-secret");
process.env.OPEN_ADMIN_DATA_DIR = dir;
process.env.APP_PASSWORD = "the-login-password";
delete process.env.APP_SESSION_SECRET;

beforeEach(() => {
  resetSessionSecretForTests();
  fs.rmSync(file, { force: true });
  delete process.env.APP_SESSION_SECRET;
  mock.restoreAll();
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const isSecret = (s: string) => /^[0-9a-f]{64}$/.test(s);

describe("resolveSessionSecret", () => {
  it("uses APP_SESSION_SECRET when it is set", () => {
    process.env.APP_SESSION_SECRET = "operator-chosen";
    assert.equal(resolveSessionSecret(), "operator-chosen");
  });

  it("creates the file on first use, owner-only, and reuses it", () => {
    const secret = resolveSessionSecret();
    assert.ok(isSecret(secret));
    assert.equal(fs.readFileSync(file, "utf-8").trim(), secret);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    resetSessionSecretForTests();
    assert.equal(resolveSessionSecret(), secret);
  });

  it("replaces an empty or damaged file instead of falling back to the password", () => {
    for (const junk of ["", "\n", "not-a-secret", "A".repeat(64)]) {
      resetSessionSecretForTests();
      fs.writeFileSync(file, junk);
      const secret = resolveSessionSecret();
      assert.ok(isSecret(secret), JSON.stringify(junk));
      assert.notEqual(secret, "the-login-password");
      assert.equal(fs.readFileSync(file, "utf-8").trim(), secret);
    }
  });

  it("leaves no temporary file behind", () => {
    fs.writeFileSync(file, "");
    resolveSessionSecret();
    assert.deepEqual(fs.readdirSync(dir), ["session-secret"]);
  });

  it("uses a temporary key, never the password, when nothing can be written", () => {
    fs.writeFileSync(file, "");
    mock.method(fs, "renameSync", () => {
      throw Object.assign(new Error("EROFS"), { code: "EROFS" });
    });
    mock.method(console, "warn", () => {});
    const secret = resolveSessionSecret();
    assert.ok(isSecret(secret));
    assert.notEqual(secret, "the-login-password");
    // The same key for every caller in the process.
    assert.equal(resolveSessionSecret(), secret);
  });
});
