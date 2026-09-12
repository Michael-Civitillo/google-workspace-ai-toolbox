/**
 * Post-build cleanup of `.next/standalone`, run automatically by `npm run build`.
 *
 * Next's file tracer copies the whole project into the standalone output (see
 * scripts/local-state.mjs for why it can't do better), which on a machine that
 * has run the app means tenants.json, sso.json, the audit log, the session
 * secret and every imported service-account key end up beside server.js — and
 * from there in a Docker image, an archive, or a backup.
 *
 * `outputFileTracingExcludes` in next.config.ts is meant to prevent exactly
 * that, but a Turbopack build (the default since Next 16) ignores it: a build
 * with dummy state in the working directory copies all of it regardless. So the
 * output is pruned here instead, and the script fails the build if anything it
 * was supposed to remove is still there.
 *
 * Only local state and developer tooling are removed. Everything the server
 * needs to answer a request — .next, node_modules, public, package.json,
 * server.js, next.config.ts — is left alone.
 */
import fs from "node:fs";
import path from "node:path";
import { pruneLocalState, collectFiles, findLocalState } from "./local-state.mjs";

const standaloneDir = path.resolve("./.next/standalone");

if (!fs.existsSync(standaloneDir)) {
  // A dev build, or `output: "standalone"` turned off — nothing to prune.
  console.log("prune-standalone: no .next/standalone (nothing to do)");
  process.exit(0);
}

/**
 * Source and tooling the compiled server never reads. Removing it keeps a
 * Docker image and the packaged executable from carrying a second copy of the
 * repository, and shrinks what has to be scanned or shipped.
 */
const DEV_ONLY = [
  "src",
  "docs",
  "scripts",
  "packaging",
  ".git",
  "tsconfig.json",
  "tsconfig.tsbuildinfo",
  "components.json",
  "eslint.config.mjs",
  "postcss.config.mjs",
  "package-lock.json",
  // Pulled in by the screenshot tooling, never by a request.
  "node_modules/sharp",
  "node_modules/@img",
];

const removedState = pruneLocalState(standaloneDir);

const removedDev = [];
for (const relative of DEV_ONLY) {
  const target = path.join(standaloneDir, relative);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    removedDev.push(relative);
  }
}

if (removedState.length > 0) {
  console.log(
    `prune-standalone: removed local state from the build output: ${removedState.join(", ")}`
  );
}
if (removedDev.length > 0) {
  console.log(`prune-standalone: removed ${removedDev.length} dev-only paths`);
}

// Backstop: prove it. A rename or a new store file would otherwise slip through
// the list above silently.
const leaked = findLocalState(collectFiles(standaloneDir));
if (leaked.length > 0) {
  console.error(
    `prune-standalone: local state is still in the build output: ${leaked.join(", ")}\n` +
      "                 It came from the working directory via Next's file tracer. " +
      "Add it to scripts/local-state.mjs."
  );
  process.exit(1);
}

console.log("prune-standalone: .next/standalone carries no local state");
