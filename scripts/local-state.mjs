/**
 * What Open Admin writes at runtime — in one place, so the build tooling can
 * never disagree about which files must not ship.
 *
 * Why this matters: the app resolves its store paths at runtime (the data
 * directory, an operator-supplied key path from a config import), so Next's
 * file tracer cannot prove which files are reachable and pulls the whole
 * project into the standalone output. On a machine that has run the app, that
 * sweeps up tenants.json, sso.json, the audit log, the session secret and the
 * imported service-account keys.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Root-level state files, matched against a path relative to the output root.
 * The suffix group covers the atomic-write temporaries (`tenants.json.<hex>.tmp`)
 * a crashed write can leave behind.
 */
export const LOCAL_STATE_RE =
  /^(tenants\.json|sso\.json|app-config\.json|session-secret|audit\.log)(\..*)?$/;

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
