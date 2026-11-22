import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { applyServerEnv, maybeRunAsNode, RUN_AS_NODE_MARKER } from "../src/server.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-server-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** A script that leaves a file behind if it runs. */
function script(name: string): { file: string; ran: () => boolean } {
  const file = path.join(tmpRoot, name);
  const proof = `${file}.ran`;
  fs.writeFileSync(file, `require("node:fs").writeFileSync(${JSON.stringify(proof)}, "yes");\n`);
  return { file, ran: () => fs.existsSync(proof) };
}

describe("maybeRunAsNode", () => {
  it("does not run a .js file dropped onto the program", () => {
    // What Explorer or Finder does: the file's path as the only argument, in an
    // environment the launcher never touched.
    const dropped = script("dropped.js");
    assert.equal(maybeRunAsNode([dropped.file], {}), false);
    assert.equal(dropped.ran(), false);
  });

  it("runs a script when the server, started by the launcher, re-executes the program", () => {
    const child = script("child.cjs");
    assert.equal(maybeRunAsNode([child.file], { [RUN_AS_NODE_MARKER]: "1" }), true);
    assert.equal(child.ran(), true);
  });

  it("ignores anything that is not an existing script", () => {
    const marked = { [RUN_AS_NODE_MARKER]: "1" };
    assert.equal(maybeRunAsNode([], marked), false);
    assert.equal(maybeRunAsNode(["--port", "3000"], marked), false);
    assert.equal(maybeRunAsNode([path.join(tmpRoot, "missing.js")], marked), false);
    assert.equal(maybeRunAsNode([script("other-value.js").file], { [RUN_AS_NODE_MARKER]: "yes" }), false);
  });
});

describe("applyServerEnv", () => {
  const options = {
    appDir: "/app",
    dataDir: "/data",
    host: "127.0.0.1",
    port: 3000,
    password: "pw-pw-pw-pw-pw",
    sessionSecret: "secret",
    instanceToken: "a".repeat(64),
  };

  it("gives the server this start's token, replacing one from outside", () => {
    const env: NodeJS.ProcessEnv = { OPEN_ADMIN_INSTANCE_TOKEN: "b".repeat(64) };
    applyServerEnv(options, env);
    assert.equal(env.OPEN_ADMIN_INSTANCE_TOKEN, "a".repeat(64));
    assert.equal(env.OPEN_ADMIN_PACKAGED, "1");
    assert.equal(env[RUN_AS_NODE_MARKER], "1");
    assert.equal(env.APP_PASSWORD, "pw-pw-pw-pw-pw");
  });

  it("keeps an operator's own session secret and store paths", () => {
    const env: NodeJS.ProcessEnv = { APP_SESSION_SECRET: "theirs", AUDIT_LOG_PATH: "/logs/audit.log" };
    applyServerEnv(options, env);
    assert.equal(env.APP_SESSION_SECRET, "theirs");
    assert.equal(env.AUDIT_LOG_PATH, "/logs/audit.log");
    assert.equal(env.SSO_CONFIG_PATH, path.join("/data", "sso.json"));
  });
});
