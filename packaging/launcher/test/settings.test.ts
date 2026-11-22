import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG_VERSION, type LauncherConfig } from "../src/config.ts";
import { resolveSettings, type SettingsInputs, type SettingsIO } from "../src/settings.ts";

const SAVED: Partial<LauncherConfig> = {
  version: CONFIG_VERSION,
  port: 3000,
  password: "the-saved-password",
  sessionSecret: "s".repeat(64),
  openBrowser: true,
};

function inputs(overrides: Partial<SettingsInputs> = {}): SettingsInputs {
  return {
    portFlag: null,
    passwordFlag: null,
    setPassword: false,
    envPassword: undefined,
    stored: SAVED,
    port: 3000,
    autoSignIn: true,
    configFile: "/data/launcher.json",
    ...overrides,
  };
}

/** Records everything shown; answers the prompt as told. */
function io(prompt: SettingsIO["prompt"] = async () => ({ password: "typed-by-a-person", generated: false })) {
  const shown: string[] = [];
  const record = (m: string) => shown.push(m);
  return { shown, io: { info: record, warn: record, plain: record, prompt } as SettingsIO };
}

describe("resolveSettings", () => {
  it("changes nothing when launcher.json already has everything", async () => {
    const { io: quiet } = io();
    const result = await resolveSettings(inputs(), quiet);
    assert.equal(result.config.password, "the-saved-password");
    assert.equal(result.passwordSource, "saved");
    assert.equal(result.toSave, null);
  });

  it("uses a password from the environment for this run without saving it", async () => {
    const { io: quiet } = io();
    const result = await resolveSettings(inputs({ envPassword: "just-for-this-run" }), quiet);
    assert.equal(result.config.password, "just-for-this-run");
    assert.equal(result.passwordSource, "environment");
    assert.equal(result.toSave, null, "launcher.json must keep the saved password");
  });

  it("saves no password at all when the environment's is the only one", async () => {
    const { io: quiet } = io();
    const result = await resolveSettings(
      inputs({ envPassword: "just-for-this-run", stored: {} }),
      quiet
    );
    assert.equal(result.config.password, "just-for-this-run");
    assert.ok(result.toSave, "the new session secret still has to be saved");
    assert.equal("password" in (result.toSave ?? {}), false);
    assert.equal(result.toSave?.sessionSecret, result.config.sessionSecret);
  });

  it("saves a password given with --password, which wins over the environment", async () => {
    const { io: quiet } = io();
    const result = await resolveSettings(
      inputs({ passwordFlag: "from-the-flag-123", envPassword: "from-the-environment" }),
      quiet
    );
    assert.equal(result.config.password, "from-the-flag-123");
    assert.equal(result.toSave?.password, "from-the-flag-123");
  });

  it("generates and saves a password on a first run with automatic sign-in", async () => {
    const { io: quiet, shown } = io();
    const result = await resolveSettings(inputs({ stored: {} }), quiet);
    assert.equal(result.passwordSource, "generated");
    assert.ok(result.config.password.length >= 20);
    assert.equal(result.toSave?.password, result.config.password);
    assert.ok(!shown.join("\n").includes(result.config.password), "printed the password");
    assert.match(shown.join("\n"), /\/data\/launcher\.json/);
  });

  it("without a terminal to ask on, says where the password is saved and never prints it", async () => {
    const { io: noTerminal, shown } = io(async () => ({ password: "generated-xyz-123456", generated: true }));
    const result = await resolveSettings(inputs({ stored: {}, autoSignIn: false }), noTerminal);
    assert.equal(result.config.password, "generated-xyz-123456");
    assert.equal(result.passwordSource, "generated");
    const text = shown.join("\n");
    assert.ok(!text.includes("generated-xyz-123456"), "printed the password");
    assert.match(text, /saved in \/data\/launcher\.json/);
  });

  it("saves a password the person chose at the prompt", async () => {
    const { io: asks } = io();
    const result = await resolveSettings(inputs({ setPassword: true }), asks);
    assert.equal(result.passwordSource, "chosen");
    assert.equal(result.toSave?.password, "typed-by-a-person");
  });

  it("remembers a port asked for by name, and only that", async () => {
    const { io: quiet } = io();
    const moved = await resolveSettings(inputs({ portFlag: 3010, port: 3010 }), quiet);
    assert.equal(moved.toSave?.port, 3010);
    const same = await resolveSettings(inputs({ portFlag: 3000, port: 3000 }), quiet);
    assert.equal(same.toSave, null);
  });
});
