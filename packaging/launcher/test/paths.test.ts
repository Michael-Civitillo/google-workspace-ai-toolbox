import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { appDirFor, defaultRoot, isPortableLayout, resolvePaths } from "../src/paths.ts";

const NOTHING_EXISTS = () => false;

describe("defaultRoot", () => {
  it("uses LOCALAPPDATA on Windows", () => {
    const root = defaultRoot("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "C:\\Users\\me");
    assert.equal(root, path.join("C:\\Users\\me\\AppData\\Local", "GoogleWorkspaceOpenAdmin"));
  });

  it("falls back to the profile when LOCALAPPDATA is unset", () => {
    const root = defaultRoot("win32", {}, "C:\\Users\\me");
    assert.ok(root.includes(path.join("AppData", "Local")));
  });

  it("uses Application Support on macOS", () => {
    const root = defaultRoot("darwin", {}, "/Users/me");
    assert.equal(root, "/Users/me/Library/Application Support/GoogleWorkspaceOpenAdmin");
  });

  it("honours XDG_DATA_HOME on Linux, else ~/.local/share", () => {
    assert.equal(
      defaultRoot("linux", { XDG_DATA_HOME: "/data/xdg" }, "/home/me"),
      "/data/xdg/GoogleWorkspaceOpenAdmin"
    );
    assert.equal(
      defaultRoot("linux", {}, "/home/me"),
      "/home/me/.local/share/GoogleWorkspaceOpenAdmin"
    );
  });
});

describe("isPortableLayout", () => {
  it("is off by default", () => {
    assert.equal(isPortableLayout("/opt/app", NOTHING_EXISTS), false);
  });

  it("is on when portable.txt sits beside the executable", () => {
    const exists = (p: string) => p === path.join("/opt/app", "portable.txt");
    assert.equal(isPortableLayout("/opt/app", exists), true);
  });

  it("is on when a data folder sits beside the executable", () => {
    const exists = (p: string) => p === path.join("/opt/app", "data");
    assert.equal(isPortableLayout("/opt/app", exists), true);
  });
});

describe("resolvePaths", () => {
  const base = {
    platform: "linux" as NodeJS.Platform,
    env: {} as NodeJS.ProcessEnv,
    homedir: "/home/me",
    exeDir: "/downloads",
    exists: NOTHING_EXISTS,
  };

  it("puts app and data under the per-user application folder", () => {
    const paths = resolvePaths(base);
    assert.equal(paths.root, "/home/me/.local/share/GoogleWorkspaceOpenAdmin");
    assert.equal(paths.appRoot, "/home/me/.local/share/GoogleWorkspaceOpenAdmin/app");
    assert.equal(paths.dataDir, "/home/me/.local/share/GoogleWorkspaceOpenAdmin/data");
    assert.equal(paths.portable, false);
  });

  it("uses the executable's folder in portable mode", () => {
    const paths = resolvePaths({
      ...base,
      exists: (p: string) => p === path.join("/downloads", "portable.txt"),
    });
    assert.equal(paths.root, "/downloads");
    assert.equal(paths.dataDir, "/downloads/data");
    assert.equal(paths.portable, true);
  });

  it("lets --root win over portable detection", () => {
    const paths = resolvePaths({
      ...base,
      rootFlag: "/srv/openadmin",
      exists: () => true,
    });
    assert.equal(paths.root, "/srv/openadmin");
    assert.equal(paths.dataDir, "/srv/openadmin/data");
    assert.equal(paths.portable, false);
  });

  it("lets --data-dir move only the data, not the app cache", () => {
    const paths = resolvePaths({ ...base, dataDirFlag: "/var/openadmin-data" });
    assert.equal(paths.dataDir, "/var/openadmin-data");
    assert.equal(paths.appRoot, "/home/me/.local/share/GoogleWorkspaceOpenAdmin/app");
  });

  it("reads OPEN_ADMIN_DATA_DIR when no flag is given, and --data-dir beats it", () => {
    const env = { OPEN_ADMIN_DATA_DIR: "/from/env" } as NodeJS.ProcessEnv;
    assert.equal(resolvePaths({ ...base, env }).dataDir, "/from/env");
    assert.equal(
      resolvePaths({ ...base, env, dataDirFlag: "/from/flag" }).dataDir,
      "/from/flag"
    );
  });
});

describe("appDirFor", () => {
  it("names the directory by version and a short content hash", () => {
    const dir = appDirFor("/root/app", "0.1.0", "a".repeat(64));
    assert.equal(dir, path.join("/root/app", `0.1.0-${"a".repeat(12)}`));
  });

  it("gives different payloads different directories", () => {
    const one = appDirFor("/root/app", "0.1.0", "abcdef0123456789");
    const two = appDirFor("/root/app", "0.1.0", "9876543210fedcba");
    assert.notEqual(one, two);
  });
});
