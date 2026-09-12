#!/usr/bin/env node
/**
 * Turn `next build`'s standalone output into the single archive the packaged
 * executable carries.
 *
 * Next's standalone output is nearly complete but deliberately leaves out two
 * things the docs tell you to copy yourself: the static assets under
 * .next/static and everything in public/. Both are copied here, so the archive
 * is exactly the directory the server expects to run from.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import {
  pruneLocalState,
  collectFiles,
  findLocalState,
} from "../scripts/local-state.mjs";

const packagingDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packagingDir, "..");
const distDir = path.join(packagingDir, "dist");
const standaloneDir = path.join(repoRoot, ".next", "standalone");

/** Never useful at runtime; some of it is source we would rather not ship. */
const PRUNE_RELATIVE = [
  "node_modules/sharp",
  "node_modules/@img",
  "src",
  "docs",
  "scripts",
  "packaging",
  ".git",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.tsbuildinfo",
  "components.json",
  "eslint.config.mjs",
  "postcss.config.mjs",
  "README.md",
  "next.config.ts",
];

/** Guard against the payload silently regaining tens of megabytes. */
const MAX_ZIP_BYTES = 40 * 1024 * 1024;

function fail(message) {
  console.error(`build-payload: ${message}`);
  process.exit(1);
}

function copyTree(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    dereference: true,
    // Symlinks in a zip are a portability problem; the standalone output has
    // none, but dereference + this filter keeps it that way if it ever does.
    filter: (src) => !path.basename(src).startsWith(".DS_Store"),
  });
}


function main() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) fail(`Node 22 or newer is required (found ${process.versions.node}).`);

  if (!fs.existsSync(path.join(standaloneDir, "server.js"))) {
    fail(
      `no standalone build at ${standaloneDir}.\n` +
        `             Run "npm run build" first (next.config.ts sets output: "standalone").`
    );
  }

  const stageDir = path.join(distDir, "payload");
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  console.log("build-payload: staging standalone output ...");
  copyTree(standaloneDir, stageDir);

  // The two directories Next leaves for us to copy.
  const staticSrc = path.join(repoRoot, ".next", "static");
  if (!fs.existsSync(staticSrc)) fail(`missing ${staticSrc}`);
  copyTree(staticSrc, path.join(stageDir, ".next", "static"));

  const publicSrc = path.join(repoRoot, "public");
  if (fs.existsSync(publicSrc)) copyTree(publicSrc, path.join(stageDir, "public"));

  for (const relative of PRUNE_RELATIVE) {
    fs.rmSync(path.join(stageDir, relative), { recursive: true, force: true });
  }
  // Local state the file tracer swept up from the working directory. `npm run
  // build` already prunes the standalone output itself (scripts/prune-standalone.mjs);
  // this repeats it on the staged copy so `npm run package:payload` on an
  // unpruned build can't ship it either.
  const prunedState = pruneLocalState(stageDir);
  if (prunedState.length > 0) {
    console.log(
      `build-payload: removed local state from the staged copy: ${prunedState.join(", ")}`
    );
  }

  console.log("build-payload: compressing ...");
  const relativePaths = collectFiles(stageDir).sort();
  const leaked = findLocalState(relativePaths);
  if (leaked.length > 0) {
    fail(
      `refusing to package local state: ${leaked.join(", ")}.\n` +
        `             These came from the working directory via Next's file tracer ` +
        `and must never ship inside the executable.`
    );
  }
  const entries = {};
  let rawBytes = 0;
  for (const relative of relativePaths) {
    const bytes = fs.readFileSync(path.join(stageDir, relative));
    rawBytes += bytes.length;
    entries[relative] = new Uint8Array(bytes);
  }

  const startedAt = Date.now();
  // A fixed timestamp (the zip epoch - the format has no room for 1970) makes
  // this step reproducible: identical staged files produce a byte-identical
  // archive. `next build` is not itself reproducible, so a full rebuild of the
  // same commit still yields a new hash; this just keeps the archiving step
  // from being a second, needless source of churn.
  const zipped = zipSync(entries, { level: 9, mtime: new Date("1980-01-01T00:00:00Z") });
  const zipPath = path.join(distDir, "payload.zip");
  fs.writeFileSync(zipPath, zipped);

  const version = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")
  ).version;
  const sha256 = createHash("sha256").update(zipped).digest("hex");

  fs.writeFileSync(
    path.join(distDir, "payload.json"),
    `${JSON.stringify(
      {
        version,
        sha256,
        fileCount: relativePaths.length,
        rawBytes,
        zipBytes: zipped.length,
        builtAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );

  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  console.log(`build-payload: ${relativePaths.length} files, ${mb(rawBytes)} raw`);
  console.log(
    `build-payload: wrote ${path.relative(repoRoot, zipPath)} ` +
      `(${mb(zipped.length)}) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
  console.log(`build-payload: sha256 ${sha256}`);

  if (zipped.length > MAX_ZIP_BYTES) {
    fail(
      `payload is ${mb(zipped.length)}, over the ${mb(MAX_ZIP_BYTES)} guard rail.\n` +
        `             Something large got traced into the standalone build - check ` +
        `outputFileTracingExcludes in next.config.ts.`
    );
  }
}

main();
