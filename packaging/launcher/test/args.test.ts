import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs, usage } from "../src/args.ts";

function ok(argv: string[]) {
  const result = parseArgs(argv);
  assert.equal(result.error, null, `unexpected error: ${result.error}`);
  assert.ok(result.args);
  return result.args;
}

describe("parseArgs", () => {
  it("defaults everything when given nothing", () => {
    const args = ok([]);
    assert.deepEqual(args, {
      port: null,
      host: null,
      dataDir: null,
      root: null,
      password: null,
      setPassword: false,
      noBrowser: false,
      resetAppCache: false,
      help: false,
      version: false,
    });
  });

  it("accepts both --flag value and --flag=value", () => {
    assert.equal(ok(["--port", "3010"]).port, 3010);
    assert.equal(ok(["--port=3010"]).port, 3010);
    assert.equal(ok(["--data-dir", "/tmp/x"]).dataDir, "/tmp/x");
    assert.equal(ok(["--data-dir=/tmp/x"]).dataDir, "/tmp/x");
  });

  it("keeps Windows paths with drive letters intact", () => {
    assert.equal(ok(["--root", "C:\\Data\\OpenAdmin"]).root, "C:\\Data\\OpenAdmin");
    assert.equal(ok(["--root=C:\\Data\\OpenAdmin"]).root, "C:\\Data\\OpenAdmin");
  });

  it("parses the boolean flags", () => {
    const args = ok(["--no-browser", "--set-password", "--reset-app-cache"]);
    assert.equal(args.noBrowser, true);
    assert.equal(args.setPassword, true);
    assert.equal(args.resetAppCache, true);
  });

  it("supports the short help and version aliases", () => {
    assert.equal(ok(["-h"]).help, true);
    assert.equal(ok(["--help"]).help, true);
    assert.equal(ok(["-v"]).version, true);
    assert.equal(ok(["--version"]).version, true);
  });

  it("rejects an unknown option", () => {
    assert.match(parseArgs(["--nope"]).error ?? "", /unknown option: --nope/);
  });

  it("rejects a positional argument", () => {
    assert.match(parseArgs(["start"]).error ?? "", /unexpected argument: start/);
  });

  it("rejects a value flag with no value", () => {
    assert.match(parseArgs(["--port"]).error ?? "", /--port needs a value/);
    assert.match(parseArgs(["--port", "--no-browser"]).error ?? "", /--port needs a value/);
    assert.match(parseArgs(["--port="]).error ?? "", /--port needs a value/);
  });

  it("rejects a port outside the valid range", () => {
    assert.match(parseArgs(["--port", "0"]).error ?? "", /between 1 and 65535/);
    assert.match(parseArgs(["--port", "70000"]).error ?? "", /between 1 and 65535/);
    assert.match(parseArgs(["--port", "http"]).error ?? "", /between 1 and 65535/);
  });

  it("rejects a value on a boolean flag", () => {
    assert.match(parseArgs(["--no-browser=yes"]).error ?? "", /does not take a value/);
  });

  it("documents every option it accepts", () => {
    const text = usage("OpenAdmin-win-x64.exe");
    for (const flag of [
      "--port",
      "--host",
      "--data-dir",
      "--root",
      "--set-password",
      "--password",
      "--no-browser",
      "--reset-app-cache",
      "--version",
      "--help",
    ]) {
      assert.ok(text.includes(flag), `usage is missing ${flag}`);
    }
  });
});
