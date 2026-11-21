#!/usr/bin/env node
/**
 * Run the application's unit tests: every src/**\/*.test.ts, under `node --test`.
 *
 * The app's source is written for Next's bundler - extensionless relative
 * imports and the "@/" alias - which plain Node cannot resolve, so each test is
 * first bundled with the code it imports. Third-party packages stay external
 * and load from node_modules as they do in production. The bundles go under
 * node_modules/.cache so they resolve those packages and never land in git or
 * in a build.
 *
 * Usage: npm run test:lib            (all tests)
 *        npm run test:lib -- scan    (only files whose name contains "scan")
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "node_modules", ".cache", "lib-tests");
const only = process.argv[2];

function findTests(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTests(full, found);
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

const tests = findTests(srcDir)
  .filter((file) => !only || path.basename(file).includes(only))
  .sort();
if (tests.length === 0) {
  console.error(only ? `test-lib: no test file matches "${only}"` : "test-lib: no tests found");
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
await build({
  entryPoints: tests,
  outdir: outDir,
  outbase: srcDir,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  // CommonJS, because googleapis is: its deep imports only expose their named
  // exports reliably to require().
  format: "cjs",
  packages: "external",
  sourcemap: "inline",
  tsconfig: path.join(root, "tsconfig.json"),
  logLevel: "warning",
});

const bundles = tests.map((file) =>
  path.join(outDir, path.relative(srcDir, file).replace(/\.tsx?$/, ".cjs"))
);
const result = spawnSync(
  process.execPath,
  ["--enable-source-maps", "--test", ...bundles],
  { stdio: "inherit", cwd: root }
);
process.exit(result.status ?? 1);
