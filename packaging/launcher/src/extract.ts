import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { unzipSync } from "fflate";
import { errorCode, fsyncDirSync, retrySync, sleepSync, TRANSIENT_CODES } from "./fsutil.ts";
import { isProcessAlive } from "./instance.ts";

/**
 * Unpacking the bundled application.
 *
 * The payload is extracted once per version into its own directory and marked
 * complete only after every file has landed, so an interrupted or
 * antivirus-blocked extraction can never be mistaken for a good one: a
 * half-written directory stays as `.tmp-<pid>` and is thrown away.
 *
 * Callers hold the application folder's lock (lock.ts) around everything
 * here, so two launches never unpack or delete at the same time. The rules
 * below hold even without it, because an older launcher does not take the
 * lock:
 *
 *   - Only names this launcher creates are ever deleted: `<version>-<hash12>`
 *     folders that carry the completion marker, `<that>.tmp-<pid>` folders
 *     whose process is gone, and `<that>.del-<pid>-<hex>` folders, which are
 *     copies already on their way out. In portable mode, or with --root, the
 *     application folder can sit among the person's own files; nothing else
 *     there is touched.
 *   - A marked folder is replaced only when it has been found damaged, and
 *     never deleted in place: it is first renamed to a `.del-` name, so a
 *     deletion that stops half-way leaves something recognisably ours rather
 *     than an unmarked folder nobody may remove.
 */

export const MARKER = ".complete";

const VERSION_DIR = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?-[0-9a-f]{12}`;
const VERSION_DIR_RE = new RegExp(`^${VERSION_DIR}$`);
const TMP_DIR_RE = new RegExp(`^${VERSION_DIR}\\.tmp-(\\d+)$`);
const DEL_DIR_RE = new RegExp(`^${VERSION_DIR}\\.del-\\d+-[0-9a-f]+$`);

/** How long the final rename may wait out Windows antivirus or indexing. */
export const FINAL_RENAME_RETRY_MS = 30_000;

export type OwnName =
  | { kind: "version" }
  | { kind: "tmp"; pid: number }
  | { kind: "del" }
  | null;

/** What a folder name in the application folder is, if it is one of ours. */
export function classifyName(name: string): OwnName {
  if (VERSION_DIR_RE.test(name)) return { kind: "version" };
  const tmp = TMP_DIR_RE.exec(name);
  if (tmp) return { kind: "tmp", pid: Number(tmp[1]) };
  if (DEL_DIR_RE.test(name)) return { kind: "del" };
  return null;
}

export function payloadHash(payload: Uint8Array): string {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export interface ExtractResult {
  appDir: string;
  /** False when a completed extraction of this exact payload already existed. */
  extracted: boolean;
  fileCount: number;
  elapsedMs: number;
}

export function isExtracted(appDir: string): boolean {
  return fs.existsSync(path.join(appDir, MARKER));
}

/**
 * Move one of our folders out of the way and delete it. The rename is what
 * makes it safe: either the whole folder now has a name that says it is being
 * discarded, or nothing happened. Returns false when it could not be moved
 * (a file in it held open, typically), in which case it is left as it was.
 */
export function discardDir(dir: string, renameRetryMs = 2000): boolean {
  const aside = `${dir}.del-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  try {
    retrySync(() => fs.renameSync(dir, aside), { totalMs: renameRetryMs });
  } catch (e) {
    if (errorCode(e) === "ENOENT") return true;
    return false;
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Left under its .del- name; the next prune takes it.
  }
  return true;
}

export interface ExtractOptions {
  /** How long the final rename may keep retrying. */
  renameRetryMs?: number;
}

/**
 * Put `tmpDir` in place as `appDir`. Returns false when a complete copy
 * appeared there first, which is then used instead.
 */
function moveIntoPlace(tmpDir: string, appDir: string, renameRetryMs: number): boolean {
  const giveUpAt = Date.now() + renameRetryMs;
  let delay = 100;
  for (;;) {
    if (isExtracted(appDir)) {
      // Never replace a complete copy: another launch finished first.
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return false;
    }
    // A folder with the final name but no marker: what an interrupted rename
    // or a damaged copy leaves. It has this payload's exact name, so it is ours.
    if (fs.existsSync(appDir) && !discardDir(appDir) && Date.now() >= giveUpAt) {
      throw new Error(`could not move the incomplete copy at ${appDir} out of the way`);
    }
    try {
      fs.renameSync(tmpDir, appDir);
      fsyncDirSync(path.dirname(appDir));
      return true;
    } catch (e) {
      const code = errorCode(e);
      if (!TRANSIENT_CODES.has(code) && code !== "EEXIST") throw e;
      if (Date.now() >= giveUpAt) throw e;
      sleepSync(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }
}

export function ensureExtracted(
  payload: Uint8Array,
  appDir: string,
  options: ExtractOptions = {}
): ExtractResult {
  if (isExtracted(appDir)) {
    return { appDir, extracted: false, fileCount: 0, elapsedMs: 0 };
  }

  const startedAt = Date.now();
  // Our own process id: anything under this name is from a process that is
  // gone (ids are reused), never from one still writing.
  const tmpDir = `${appDir}.tmp-${process.pid}`;
  fs.rmSync(tmpDir, { recursive: true, force: true });

  let fileCount = 0;
  let placed = false;
  try {
    const files = unzipSync(payload);
    const root = path.resolve(tmpDir);
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith("/")) continue;
      // Zip-slip guard. Entry names are data as far as this code is concerned,
      // so refuse anything that would land outside the extraction directory:
      // absolute paths, drive letters, NUL bytes, or `..` segments that climb
      // back out after resolution.
      if (name.includes("\0") || path.isAbsolute(name)) {
        throw new Error(`refusing to extract unsafe archive entry "${name}"`);
      }
      const destination = path.resolve(root, name);
      if (destination === root || !destination.startsWith(root + path.sep)) {
        throw new Error(
          `refusing to extract archive entry "${name}" outside the target directory`
        );
      }
      retrySync(() => fs.mkdirSync(path.dirname(destination), { recursive: true }), {
        totalMs: 2000,
      });
      retrySync(() => fs.writeFileSync(destination, bytes), { totalMs: 2000 });
      fileCount++;
    }
    // The marker alone is flushed to disk before the rename. Flushing every
    // file as well costs about a second on Linux (2,300 files) and more on
    // Windows; a copy damaged by a power cut right after unpacking is instead
    // caught by the check made before every start, and unpacked again.
    const markerFd = fs.openSync(path.join(tmpDir, MARKER), "w");
    try {
      fs.writeSync(markerFd, `${new Date().toISOString()}\n`);
      fs.fsyncSync(markerFd);
    } finally {
      fs.closeSync(markerFd);
    }
    retrySync(() => fs.mkdirSync(path.dirname(appDir), { recursive: true }), { totalMs: 2000 });
    placed = moveIntoPlace(tmpDir, appDir, options.renameRetryMs ?? FINAL_RENAME_RETRY_MS);
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }

  return {
    appDir,
    extracted: placed,
    fileCount: placed ? fileCount : 0,
    elapsedMs: Date.now() - startedAt,
  };
}

export interface PruneDeps {
  isAlive?: (pid: number) => boolean;
}

/**
 * The folders in `appRoot` that this launcher may delete, other than
 * `keepDir`: complete copies of other versions, temporary folders whose
 * process is gone, and folders already being discarded.
 */
function deletable(appRoot: string, keepDir: string | null, deps: PruneDeps): string[] {
  const isAlive = deps.isAlive ?? isProcessAlive;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(appRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    // Never a file, and never a link: only a real folder with one of our names.
    if (!entry.isDirectory()) continue;
    const full = path.join(appRoot, entry.name);
    if (keepDir !== null && full === keepDir) continue;
    const own = classifyName(entry.name);
    if (!own) continue;
    if (own.kind === "version" && !isExtracted(full)) continue;
    if (own.kind === "tmp" && (own.pid === process.pid || isAlive(own.pid))) continue;
    out.push(entry.name);
  }
  return out.sort();
}

function remove(appRoot: string, name: string): boolean {
  const full = path.join(appRoot, name);
  const own = classifyName(name);
  if (own?.kind === "version") return discardDir(full);
  try {
    fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false; // Locked by a scanner or another instance - try again next launch.
  }
}

/** Delete our own folders other than `keepDir` (see deletable). Best effort. */
export function pruneOtherVersions(appRoot: string, keepDir: string, deps: PruneDeps = {}): string[] {
  return deletable(appRoot, keepDir, deps).filter((name) => remove(appRoot, name));
}

/**
 * --reset-app-cache: delete every unpacked copy this launcher made, the
 * current version's included, and nothing else in the folder.
 */
export function resetAppCache(appRoot: string, deps: PruneDeps = {}): string[] {
  return deletable(appRoot, null, deps).filter((name) => remove(appRoot, name));
}
