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
  assertStandaloneShape,
  collectFiles,
  findLocalState,
  pruneLocalState,
  pruneToAllowList,
} from "../scripts/local-state.mjs";

const packagingDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packagingDir, "..");
const distDir = path.join(packagingDir, "dist");
const standaloneDir = path.join(repoRoot, ".next", "standalone");

/**
 * Inside node_modules: never used at runtime. Everything outside the five
 * top-level names the server runs from is removed by pruneToAllowList.
 */
const PRUNE_RELATIVE = ["node_modules/sharp", "node_modules/@img"];

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


/**
 * The absolute folders Next recorded for this build: where it ran, and the
 * roots it traced and bundled from. Longest first, so a root inside another is
 * replaced before the folder that contains it.
 */
function buildRoots(stageDir) {
  const file = path.join(stageDir, ".next", "required-server-files.json");
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    fail(`cannot read ${file}: ${e.message}`);
  }
  const candidates = [
    recorded.appDir,
    recorded.config?.outputFileTracingRoot,
    recorded.config?.turbopack?.root,
    recorded.config?.repoRoot,
    repoRoot,
  ];
  return [...new Set(candidates)]
    .filter((p) => typeof p === "string" && path.isAbsolute(p) && p !== path.parse(p).root)
    .sort((a, b) => b.length - a.length);
}

/** How a path appears in the files: as itself, and escaped inside a JSON string. */
function spellings(root) {
  return [...new Set([root, JSON.stringify(root).slice(1, -1)])];
}

/**
 * Next writes the absolute path of the folder it built in into two files the
 * server ships with: server.js (the inlined config: outputFileTracingRoot,
 * turbopack.root, repoRoot) and .next/required-server-files.json (the same
 * config, plus appDir). Nothing reads those at runtime - they steer the build
 * and the dev server - but they put the builder's folder, and usually their
 * user name, into every copy of the executable, and make the payload hash
 * depend on where it was built. Each becomes ".", which is what it means once
 * the files sit in the app folder. Returns the files changed.
 */
function scrubBuildPaths(stageDir, roots) {
  const changed = [];
  for (const relative of ["server.js", path.join(".next", "required-server-files.json")]) {
    const file = path.join(stageDir, relative);
    const before = fs.readFileSync(file, "utf-8");
    let after = before;
    for (const root of roots) {
      for (const spelled of spellings(root)) {
        after = after.split(`"${spelled}"`).join('"."');
      }
    }
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed.push(relative.split(path.sep).join("/"));
    }
  }
  return changed;
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

  // Whatever the file tracer copied from the project folder. `npm run build`
  // already reduces the standalone output to the same allow-list
  // (scripts/prune-standalone.mjs); this repeats it on the staged copy, so
  // `npm run package:payload` on an unpruned build can't ship it either.
  const outside = pruneToAllowList(stageDir);
  if (outside.length > 0) {
    console.log(
      `build-payload: removed from the staged copy (not something the server runs from): ` +
        outside.join(", ")
    );
  }
  for (const relative of PRUNE_RELATIVE) {
    fs.rmSync(path.join(stageDir, relative), { recursive: true, force: true });
  }
  const prunedState = pruneLocalState(stageDir);
  if (prunedState.length > 0) {
    console.log(
      `build-payload: removed local state from the staged copy: ${prunedState.join(", ")}`
    );
  }
  try {
    assertStandaloneShape(stageDir);
  } catch (e) {
    fail(e.message);
  }

  const roots = buildRoots(stageDir);
  const scrubbed = scrubBuildPaths(stageDir, roots);
  if (scrubbed.length > 0) {
    console.log(`build-payload: removed the build folder's path from ${scrubbed.join(", ")}`);
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
  const needles = roots.flatMap(spellings).map((s) => Buffer.from(s, "utf-8"));
  const stillNamed = [];
  for (const relative of relativePaths) {
    const bytes = fs.readFileSync(path.join(stageDir, relative));
    rawBytes += bytes.length;
    entries[relative] = new Uint8Array(bytes);
    if (needles.some((needle) => bytes.includes(needle))) stillNamed.push(relative);
  }
  if (stillNamed.length > 0) {
    // Not fatal: every build shipped like this before the check existed.
    console.warn(
      `build-payload: warning: the build folder's path is still in ${stillNamed.length} ` +
        `file(s): ${stillNamed.slice(0, 5).join(", ")}${stillNamed.length > 5 ? ", ..." : ""}`
    );
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
