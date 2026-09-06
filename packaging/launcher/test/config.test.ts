import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  applyEnvFile,
  generatePassword,
  generateSessionSecret,
  MIN_PASSWORD_LENGTH,
  parseEnvFile,
  promptForPassword,
  readConfigFile,
  writeConfigFile,
  type LauncherConfig,
} from "../src/config.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-config-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function tmpFile(name: string): string {
  return path.join(tmpRoot, name);
}

describe("launcher.json", () => {
  it("round-trips a full config", () => {
    const file = tmpFile("round-trip.json");
    const config: LauncherConfig = {
      version: 1,
      port: 3010,
      password: "hunter2-hunter2",
      sessionSecret: "abc123",
      openBrowser: false,
    };
    writeConfigFile(file, config);
    assert.deepEqual(readConfigFile(file), config);
  });

  it("leaves no temporary file behind", () => {
    const file = tmpFile("atomic.json");
    writeConfigFile(file, {
      version: 1,
      port: 3000,
      password: "x".repeat(12),
      sessionSecret: "s",
      openBrowser: true,
    });
    const strays = fs.readdirSync(tmpRoot).filter((n) => n.includes("atomic.json.tmp"));
    assert.deepEqual(strays, []);
  });

  it("treats a missing or corrupt file as no settings at all", () => {
    assert.deepEqual(readConfigFile(tmpFile("absent.json")), {});
    const broken = tmpFile("broken.json");
    fs.writeFileSync(broken, "{not json");
    assert.deepEqual(readConfigFile(broken), {});
    const wrongShape = tmpFile("array.json");
    fs.writeFileSync(wrongShape, "[1,2,3]");
    assert.deepEqual(readConfigFile(wrongShape), {});
  });

  it("drops fields of the wrong type instead of trusting them", () => {
    const file = tmpFile("typed.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ port: "3000", password: 42, sessionSecret: "", openBrowser: "yes" })
    );
    assert.deepEqual(readConfigFile(file), {});
  });
});

describe("parseEnvFile", () => {
  it("reads simple assignments", () => {
    assert.deepEqual(parseEnvFile("A=1\nB=two\n"), { A: "1", B: "two" });
  });

  it("skips comments and blank lines", () => {
    assert.deepEqual(parseEnvFile("# note\n\n  \nA=1\n"), { A: "1" });
  });

  it("keeps '=' inside a value", () => {
    assert.deepEqual(parseEnvFile("KEY=a=b=c"), { KEY: "a=b=c" });
  });

  it("removes one layer of matching quotes", () => {
    assert.deepEqual(parseEnvFile('A="C:\\Program Files\\x"'), { A: "C:\\Program Files\\x" });
    assert.deepEqual(parseEnvFile("B='spaced value'"), { B: "spaced value" });
    assert.deepEqual(parseEnvFile(`C="unbalanced`), { C: '"unbalanced' });
  });

  it("tolerates CRLF line endings", () => {
    assert.deepEqual(parseEnvFile("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
  });

  it("ignores lines that aren't assignments to a valid name", () => {
    assert.deepEqual(parseEnvFile("no-equals\n=value\n1BAD=x\nGOOD=y"), { GOOD: "y" });
  });
});

describe("applyEnvFile", () => {
  it("sets variables that aren't already in the environment", () => {
    const file = tmpFile("one.env");
    fs.writeFileSync(file, "SMOKE_TEST_FRESH=applied\n");
    delete process.env.SMOKE_TEST_FRESH;
    const applied = applyEnvFile(file);
    assert.deepEqual(applied, ["SMOKE_TEST_FRESH"]);
    assert.equal(process.env.SMOKE_TEST_FRESH, "applied");
    delete process.env.SMOKE_TEST_FRESH;
  });

  it("never overwrites what the operator already set", () => {
    const file = tmpFile("two.env");
    fs.writeFileSync(file, "SMOKE_TEST_EXISTING=from-file\n");
    process.env.SMOKE_TEST_EXISTING = "from-environment";
    assert.deepEqual(applyEnvFile(file), []);
    assert.equal(process.env.SMOKE_TEST_EXISTING, "from-environment");
    delete process.env.SMOKE_TEST_EXISTING;
  });

  it("is a no-op when the file is absent", () => {
    assert.deepEqual(applyEnvFile(tmpFile("absent.env")), []);
  });
});

describe("secrets", () => {
  it("generates a long random session secret", () => {
    const a = generateSessionSecret();
    assert.equal(a.length, 64);
    assert.notEqual(a, generateSessionSecret());
  });

  it("generates a password that passes its own length rule", () => {
    assert.ok(generatePassword().length >= MIN_PASSWORD_LENGTH);
  });
});

describe("promptForPassword", () => {
  it("generates one when there is no terminal to ask on", async () => {
    const result = await promptForPassword(
      () => {},
      async () => {
        throw new Error("should not prompt");
      },
      false
    );
    assert.equal(result.generated, true);
    assert.ok(result.password.length >= MIN_PASSWORD_LENGTH);
  });

  it("accepts a confirmed password", async () => {
    const result = await promptForPassword(() => {}, async () => "correct horse battery", true);
    assert.deepEqual(result, { password: "correct horse battery", generated: false });
  });

  it("re-asks when the two entries differ", async () => {
    const answers = ["first-attempt-long", "typo-attempt-long", "second-attempt", "second-attempt"];
    const messages: string[] = [];
    const result = await promptForPassword(
      (s) => messages.push(s),
      async () => answers.shift() ?? "",
      true
    );
    assert.equal(result.password, "second-attempt");
    assert.match(messages.join("\n"), /don't match/);
  });

  it("re-asks when the password is too short", async () => {
    const answers = ["short", "long-enough-password", "long-enough-password"];
    const messages: string[] = [];
    const result = await promptForPassword(
      (s) => messages.push(s),
      async () => answers.shift() ?? "",
      true
    );
    assert.equal(result.password, "long-enough-password");
    assert.match(messages.join("\n"), /at least 12 characters/);
  });

  it("gives up and generates one after three failed attempts", async () => {
    const result = await promptForPassword(() => {}, async () => "tiny", true);
    assert.equal(result.generated, true);
  });
});
