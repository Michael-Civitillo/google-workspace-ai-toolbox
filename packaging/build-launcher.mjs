#!/usr/bin/env node
/**
 * Bundle the launcher and turn it into a Node single-executable-application
 * blob, with the application archive attached as an SEA asset.
 *
 * Output (all under packaging/dist):
 *   launcher.cjs     the bundled launcher, runnable directly for debugging
 *   sea-config.json  input for `node --experimental-sea-config`
 *   sea-prep.blob    what build-exe.ps1 / build-bin.sh inject into node
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packagingDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packagingDir, "..");
const distDir = path.join(packagingDir, "dist");

function fail(message) {
  console.error(`build-launcher: ${message}`);
  process.exit(1);
}

const payloadJsonPath = path.join(distDir, "payload.json");
if (!fs.existsSync(payloadJsonPath)) {
  fail('no payload.json - run "npm run package:payload" first.');
}
const payload = JSON.parse(fs.readFileSync(payloadJsonPath, "utf-8"));
const version = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")
).version;

const outfile = path.join(distDir, "launcher.cjs");

console.log("build-launcher: bundling launcher ...");
await build({
  entryPoints: [path.join(packagingDir, "launcher", "src", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __PAYLOAD_SHA256__: JSON.stringify(payload.sha256),
  },
});
console.log(
  `build-launcher: launcher.cjs is ${(fs.statSync(outfile).size / 1024).toFixed(0)} KB`
);

// `assets` paths are resolved relative to the config file's directory, so the
// config lives beside the payload and is invoked with dist/ as the cwd.
const seaConfigPath = path.join(distDir, "sea-config.json");
fs.writeFileSync(
  seaConfigPath,
  `${JSON.stringify(
    {
      main: "launcher.cjs",
      output: "sea-prep.blob",
      disableExperimentalSEAWarning: true,
      // Code cache is tied to the exact Node build and restricts how the main
      // script may load other code; the launcher is small enough that the
      // startup saving isn't worth those constraints.
      useCodeCache: false,
      assets: { "payload.zip": "payload.zip" },
    },
    null,
    2
  )}\n`
);

console.log("build-launcher: generating the single-executable blob ...");
execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], {
  cwd: distDir,
  stdio: "inherit",
});

const blobPath = path.join(distDir, "sea-prep.blob");
if (!fs.existsSync(blobPath)) fail("sea-prep.blob was not produced.");
console.log(
  `build-launcher: sea-prep.blob is ` +
    `${(fs.statSync(blobPath).size / 1024 / 1024).toFixed(1)} MB ` +
    `(app version ${version})`
);
console.log(
  "build-launcher: next run " +
    (process.platform === "win32" ? "npm run package:exe" : "npm run package:bin")
);
