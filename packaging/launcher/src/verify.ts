import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Checking an unpacked copy of the application against the manifest baked
 * into the launcher at build time (every file's path, size and SHA-256).
 *
 * The embedded archive's hash is checked when it is unpacked, but later starts
 * run whatever is in the folder. In portable mode that folder sits beside the
 * executable, often somewhere other people can write to (a shared folder, a
 * USB stick that travels), so files planted or swapped there would run inside
 * the genuine program. A full check (every file read and hashed, nothing extra
 * allowed, no links) is made whenever the application folder is not the
 * per-user one; elsewhere a quick check (every file present at its size)
 * catches what antivirus quarantine or a power cut leaves behind.
 *
 * What a check cannot rule out is a file swapped after it: the server loads
 * parts of itself on first use, minutes later. A folder other people can
 * write to is not a safe place to run a program from at all; the check makes
 * tampering there visible rather than impossible.
 */

/** [path relative to the app folder with "/" separators, size in bytes, sha256 hex]. */
export type ManifestEntry = [string, number, string];

export type CheckMode = "quick" | "full";

/** Files the launcher itself keeps in an unpacked copy, outside the manifest. */
export const LAUNCHER_FILES: ReadonlySet<string> = new Set([".complete", ".verify"]);

/** Parse the manifest baked into the launcher; throws on anything malformed. */
export function parseManifest(json: string): ManifestEntry[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("the file manifest is not a list");
  for (const entry of parsed) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "number" ||
      typeof entry[2] !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry[2])
    ) {
      throw new Error("the file manifest has a malformed entry");
    }
  }
  return parsed as ManifestEntry[];
}

/**
 * Files an operating system drops into a folder by itself when someone looks
 * inside: Finder's .DS_Store, the "._name" companions macOS writes on drives
 * that can't hold its metadata, Explorer's thumbnail cache and folder
 * settings. They are not part of the application, and one appearing must not
 * cost a fresh unpack of two thousand files on every start. They are deleted
 * rather than ignored: a file left in place under such a name could still be
 * served or loaded, and the folder must hold exactly what the build put there.
 */
function isOsClutter(relative: string): boolean {
  const name = relative.slice(relative.lastIndexOf("/") + 1);
  return (
    name === ".DS_Store" ||
    name.startsWith("._") ||
    /^(thumbs|ehthumbs)\.db$/i.test(name) ||
    /^desktop\.ini$/i.test(name)
  );
}

function fullPath(appDir: string, relative: string): string {
  return path.join(appDir, ...relative.split("/"));
}

/** Every file under `dir`, relative and "/"-separated; links and devices reported. */
function walk(dir: string, base: string, files: string[], odd: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full).split(path.sep).join("/");
    if (entry.isDirectory()) walk(full, base, files, odd);
    else if (entry.isFile()) files.push(relative);
    else odd.push(relative);
  }
}

/**
 * What is wrong with the copy in `appDir`, or null when it matches the
 * manifest. The answer names one file, which is enough to act on: any
 * mismatch means the copy is replaced.
 */
export function checkAppDir(
  appDir: string,
  manifest: readonly ManifestEntry[],
  mode: CheckMode
): string | null {
  if (mode === "quick") {
    for (const [relative, size] of manifest) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath(appDir, relative));
      } catch {
        return `${relative} is missing`;
      }
      if (!stat.isFile()) return `${relative} is not a regular file`;
      if (stat.size !== size) return `${relative} has the wrong size`;
    }
    return null;
  }

  const files: string[] = [];
  const odd: string[] = [];
  try {
    walk(appDir, appDir, files, odd);
  } catch (e) {
    return `the folder could not be read (${(e as Error).message})`;
  }
  if (odd.length > 0) return `${odd[0]} is a link or device, not a file`;
  const expected = new Map(manifest.map(([relative, size, hash]) => [relative, { size, hash }]));
  for (const relative of files) {
    if (expected.has(relative) || LAUNCHER_FILES.has(relative)) continue;
    if (isOsClutter(relative)) {
      try {
        fs.rmSync(fullPath(appDir, relative), { force: true });
        continue;
      } catch {
        // Can't be removed (a read-only drive): then it counts as added.
      }
    }
    return `${relative} was added`;
  }
  const present = new Set(files);
  for (const [relative, size, hash] of manifest) {
    if (!present.has(relative)) return `${relative} is missing`;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(fullPath(appDir, relative));
    } catch {
      return `${relative} could not be read`;
    }
    if (bytes.length !== size) return `${relative} has the wrong size`;
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== hash) {
      return `${relative} was changed`;
    }
  }
  return null;
}

/**
 * Ask for a full check of `appDir` on the next start. Left by a start that
 * failed after the server's code began loading: the cause may be a damaged
 * file the quick check cannot see.
 */
export function requestFullCheck(appDir: string): void {
  try {
    fs.writeFileSync(path.join(appDir, ".verify"), `${new Date().toISOString()}\n`);
  } catch {
    // The next start will simply make the usual check.
  }
}

export function fullCheckRequested(appDir: string): boolean {
  return fs.existsSync(path.join(appDir, ".verify"));
}

export function clearFullCheckRequest(appDir: string): void {
  try {
    fs.rmSync(path.join(appDir, ".verify"), { force: true });
  } catch {
    // Harmless: it only costs one more full check.
  }
}
