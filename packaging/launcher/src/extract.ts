import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { unzipSync } from "fflate";

/**
 * Unpacking the bundled application.
 *
 * The payload is extracted once per version into its own directory and marked
 * complete only after every file has landed, so an interrupted or
 * antivirus-blocked extraction can never be mistaken for a good one: a
 * half-written directory stays as `.tmp-<pid>` and is thrown away.
 */

const MARKER = ".complete";
const RETRYABLE = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

export function payloadHash(payload: Uint8Array): string {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/** Block the current thread without spinning the CPU or the event loop. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows antivirus and indexing services hold brief locks on files that were
 * just written, which surfaces as EBUSY/EPERM on the next operation. Retrying
 * with a short backoff turns a hard failure into a pause nobody notices.
 */
function withRetry<T>(operation: () => T, attempts = 5): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= attempts - 1) throw e;
      sleepSync(100 * 2 ** attempt);
    }
  }
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

export function ensureExtracted(payload: Uint8Array, appDir: string): ExtractResult {
  if (isExtracted(appDir)) {
    return { appDir, extracted: false, fileCount: 0, elapsedMs: 0 };
  }

  const startedAt = Date.now();
  const tmpDir = `${appDir}.tmp-${process.pid}`;
  fs.rmSync(tmpDir, { recursive: true, force: true });

  let fileCount = 0;
  try {
    const files = unzipSync(payload);
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith("/")) continue;
      const destination = path.join(tmpDir, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      withRetry(() => fs.writeFileSync(destination, bytes));
      fileCount++;
    }
    fs.writeFileSync(path.join(tmpDir, MARKER), `${new Date().toISOString()}\n`, "utf-8");
    // A previous partial attempt under the final name would block the rename.
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(appDir), { recursive: true });
    withRetry(() => fs.renameSync(tmpDir, appDir));
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }

  return { appDir, extracted: true, fileCount, elapsedMs: Date.now() - startedAt };
}

/** Delete every extracted version except `keepDir`. Best effort. */
export function pruneOtherVersions(appRoot: string, keepDir: string): string[] {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(appRoot, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(appRoot, entry.name);
    if (full === keepDir) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Locked by a scanner or another instance - try again next launch.
    }
  }
  return removed;
}
