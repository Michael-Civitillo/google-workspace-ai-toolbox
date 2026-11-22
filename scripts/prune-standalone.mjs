/**
 * Post-build cleanup of `.next/standalone`, run automatically by `npm run build`.
 *
 * Next's file tracer copies the whole project folder into the standalone
 * output (see scripts/local-state.mjs for why it can't do better). Whatever is
 * in that folder goes along: on a machine that has run the app, tenants.json,
 * sso.json, the audit log, the session secret and imported service-account
 * keys; on anyone's machine, a key file kept beside the code under any name.
 * From there it ends up in a Docker image, an archive or the desktop build.
 *
 * `outputFileTracingExcludes` in next.config.ts is meant to prevent that, but a
 * Turbopack build (the default since Next 16) ignores it. So the output is
 * reduced here to the five things the server runs from (server.js,
 * package.json, .next, node_modules, public) and everything else at its top is
 * deleted, whatever it is called. The build fails if anything else is left, if
 * server.js is not at the top (a nested output, which a top-level check would
 * pass over), or if a known local-state file survives anywhere it is looked for.
 */
import fs from "node:fs";
import path from "node:path";
import {
  assertStandaloneShape,
  collectFiles,
  findLocalState,
  pruneToAllowList,
} from "./local-state.mjs";

const standaloneDir = path.resolve("./.next/standalone");

if (!fs.existsSync(standaloneDir)) {
  // A dev build, or `output: "standalone"` turned off — nothing to prune.
  console.log("prune-standalone: no .next/standalone (nothing to do)");
  process.exit(0);
}

function fail(message) {
  console.error(`prune-standalone: ${message}`);
  process.exit(1);
}

// Before deleting anything: a nested output has no server.js at the top, and
// pruning it to the allow-list would only hide where the copy went.
if (!fs.existsSync(path.join(standaloneDir, "server.js"))) {
  try {
    assertStandaloneShape(standaloneDir);
  } catch (e) {
    fail(e.message);
  }
}

const removed = pruneToAllowList(standaloneDir);

/** Inside node_modules: pulled in by the screenshot tooling, never by a request. */
const UNUSED_MODULES = ["node_modules/sharp", "node_modules/@img"];
for (const relative of UNUSED_MODULES) {
  fs.rmSync(path.join(standaloneDir, relative), { recursive: true, force: true });
}

if (removed.length > 0) {
  console.log(
    `prune-standalone: removed ${removed.length} entries the server does not run from: ` +
      removed.join(", ")
  );
}

// Backstop: prove it.
try {
  assertStandaloneShape(standaloneDir);
} catch (e) {
  fail(e.message);
}
const leaked = findLocalState(collectFiles(standaloneDir));
if (leaked.length > 0) {
  fail(
    `local state is still in the build output: ${leaked.join(", ")}\n` +
      "                 It came from the working directory via Next's file tracer."
  );
}

console.log(
  `prune-standalone: .next/standalone holds only what the server runs from ` +
    `(${fs.readdirSync(standaloneDir).sort().join(", ")})`
);
