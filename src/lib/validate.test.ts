import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { validateCredentialsFilePath, ValidationError } from "./validate";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-test-"));
after(() => {
  delete process.env.GWS_CREDENTIALS_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("validateCredentialsFilePath", () => {
  it("refuses a network path", () => {
    for (const p of ["//server/share/key.json", "\\\\server\\share\\key.json", "\\\\?\\C:\\keys\\key.json"]) {
      assert.throws(() => validateCredentialsFilePath(p), ValidationError, p);
    }
  });

  it("keeps a key inside the allowed folder, existing or not yet written", () => {
    const allowed = path.join(dir, "keys");
    fs.mkdirSync(allowed);
    process.env.GWS_CREDENTIALS_DIR = allowed;
    fs.writeFileSync(path.join(allowed, "a.json"), "{}");
    assert.equal(validateCredentialsFilePath(path.join(allowed, "a.json")), path.join(allowed, "a.json"));
    assert.equal(validateCredentialsFilePath(path.join(allowed, "new.json")), path.join(allowed, "new.json"));
  });

  it("refuses a link inside the allowed folder that points outside it", () => {
    const allowed = path.join(dir, "keys");
    process.env.GWS_CREDENTIALS_DIR = allowed;
    const secret = path.join(dir, "elsewhere.json");
    fs.writeFileSync(secret, "{}");
    const link = path.join(allowed, "link.json");
    fs.symlinkSync(secret, link);
    assert.throws(() => validateCredentialsFilePath(link), /link to somewhere else/);
    // And a folder link the same way.
    const outsideDir = path.join(dir, "outside");
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, path.join(allowed, "sub"));
    assert.throws(() => validateCredentialsFilePath(path.join(allowed, "sub", "x.json")), /link to somewhere else/);
  });
});
