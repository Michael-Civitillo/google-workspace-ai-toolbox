/**
 * What may ship from a build, and what Open Admin writes at runtime — in one
 * place, so the build tooling can never disagree about which files must not
 * ship.
 *
 * Why this matters: the app resolves its store paths at runtime (the data
 * directory, an operator-supplied key path from a config import), so Next's
 * file tracer cannot prove which files are reachable and copies the whole
 * project folder into the standalone output. Whatever sits in that folder goes
 * with it: tenants.json, sso.json, the audit log, the session secret, imported
 * service-account keys, and any key file someone happens to keep there under a
 * name of their own choosing.
 *
 * A list of names to remove can never be complete, so the top of the output is
 * checked against the short list of things the server actually runs from
 * (STANDALONE_ALLOWED) and everything else is removed. The local-state names
 * below stay as a second, independent check.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Everything the standalone server needs, at the top of its folder. Nothing
 * else in a build output is ever needed to answer a request: the app itself is
 * compiled into .next/server.
 */
export const STANDALONE_ALLOWED = Object.freeze([
  "server.js",
  "package.json",
  ".next",
  "node_modules",
  "public",
]);

/** Top-level names in `dir` that are not on the allow-list. */
export function outsideAllowList(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => !STANDALONE_ALLOWED.includes(name))
    .sort();
}

/**
 * Delete everything at the top of `dir` that is not on the allow-list.
 * Returns the names removed.
 */
export function pruneToAllowList(dir) {
  const removed = outsideAllowList(dir);
  for (const name of removed) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  return removed;
}

/**
 * Throws unless `dir` is a standalone server folder: `server.js` at its top
 * and nothing outside the allow-list beside it. A server.js that is missing
 * here usually means Next nested the output under a parent folder it took for
 * the project root (see outputFileTracingRoot in next.config.ts), and a check
 * of the top level would then pass over a whole copy of that parent.
 */
export function assertStandaloneShape(dir) {
  if (!fs.existsSync(path.join(dir, "server.js"))) {
    const nested = findServerJs(dir, 4);
    throw new Error(
      `no server.js at the top of ${dir}` +
        (nested ? ` (found one at ${nested}: the output is nested)` : "") +
        `. outputFileTracingRoot in next.config.ts must be the project folder.`
    );
  }
  const stray = outsideAllowList(dir);
  if (stray.length > 0) {
    throw new Error(`unexpected entries beside server.js: ${stray.join(", ")}`);
  }
}

function findServerJs(dir, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "server.js") return path.join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const found = findServerJs(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * Root-level state files, matched against a path relative to the output root.
 * The suffix group covers the atomic-write temporaries (`tenants.json.<hex>.tmp`)
 * a crashed write can leave behind.
 */
export const LOCAL_STATE_RE =
  /^(tenants\.json|sso\.json|app-config\.json|delegation-sightings\.json|security-check-history\.json|session-secret|audit\.log)(\..*)?$/;

/** Environment files, which carry the password and the session secret. */
export const ENV_FILE_RE = /^\.env(\..*)?$/;

/** The one directory the app writes key files into. */
export const CREDENTIALS_DIR = "credentials";

/**
 * Delete every local-state file at the top level of `dir`. Returns the names
 * removed, so a build step can say what it took out.
 */
export function pruneLocalState(dir) {
  const removed = [];
  if (!fs.existsSync(dir)) return removed;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const { name } = entry;
    if (
      name === CREDENTIALS_DIR ||
      LOCAL_STATE_RE.test(name) ||
      ENV_FILE_RE.test(name)
    ) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

/** Every file under `dir`, as POSIX paths relative to it. */
export function collectFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/**
 * Local state still present in a set of output-relative paths. Anchored at the
 * root on purpose: a dependency of ours may legitimately ship a file called
 * `audit.log`, and only the copy beside `server.js` is ours.
 */
export function findLocalState(relativePaths) {
  return relativePaths.filter(
    (p) =>
      LOCAL_STATE_RE.test(p) ||
      ENV_FILE_RE.test(p) ||
      p.startsWith(`${CREDENTIALS_DIR}/`)
  );
}
