import { readFileSync, renameSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import type { Tenant } from "./tenant-types";
import { writeTextFileAtomic } from "./json-store";
import { validateCredentialsFilePath } from "./validate";
import { dataPath } from "./data-dir";

/**
 * Bundling of service-account key FILES into configuration exports, and
 * putting them back on disk during import — so backup/restore is a single
 * file with no side-channel key copying.
 */

/** Service-account keys are ~2.5 KB; anything near this cap isn't one. */
export const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;

/**
 * Read every tenant's key file for embedding in an export bundle, deduped by
 * path (tenants may share a key). Unreadable, oversized, or non-JSON files
 * are silently skipped — the bundle then carries only the path, and import
 * warns if the file is missing on the target, same as pre-embedding bundles.
 */
export function collectCredentialFiles(
  tenants: Tenant[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tenants) {
    const p = t.credentialsFile;
    if (!p || out[p] !== undefined) continue;
    try {
      const raw = readFileSync(p, "utf-8");
      if (Buffer.byteLength(raw, "utf-8") > MAX_CREDENTIAL_FILE_BYTES) continue;
      // Only a service-account key is worth embedding. Anything else that
      // happens to be JSON at that path (a tenant pointed at the wrong file,
      // or at a file it should not be reading) stays out of the bundle.
      if (!looksLikeServiceAccountKey(raw)) continue;
      out[p] = raw;
    } catch {
      // Missing or unreadable — nothing to embed for this tenant.
    }
  }
  return out;
}

function looksLikeServiceAccountKey(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    return (
      !!parsed &&
      typeof parsed === "object" &&
      typeof parsed.client_email === "string" &&
      typeof parsed.private_key === "string"
    );
  } catch {
    return false;
  }
}

/**
 * The one directory a restore is allowed to write into: the operator's
 * allowlisted directory when one is configured, otherwise a `credentials/`
 * directory in the data directory (gitignored).
 */
export function credentialFallbackDir(): string {
  const allowed = process.env.GWS_CREDENTIALS_DIR;
  return allowed
    ? path.resolve(allowed)
    : dataPath("credentials");
}

/** True when `candidate` resolves to a path strictly inside `dir`. */
function isInside(dir: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * A filesystem-safe basename derived from the bundle's original path, which
 * may come from a different OS entirely (e.g. `C:\keys\sa.json` restored
 * onto Linux).
 */
function safeBaseName(originalPath: string): string {
  const last = originalPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
  let name = last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "");
  if (!name || /^\.?json$/i.test(name)) name = "service-account.json";
  if (!name.toLowerCase().endsWith(".json")) name += ".json";
  return name;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/**
 * Ensure `content` exists at `target`. An existing identical file is left
 * alone; an existing different file is moved aside to `<target>.bak-<ts>`
 * first, so a restore can never silently destroy a key.
 */
async function writeKeyFile(
  target: string,
  content: string
): Promise<"written" | "unchanged" | "replaced"> {
  let existing: string | null = null;
  try {
    existing = readFileSync(target, "utf-8");
  } catch {
    // Missing or unreadable — treat as absent and write fresh.
  }
  if (existing !== null && existing === content) return "unchanged";
  if (existing !== null) {
    try {
      renameSync(target, `${target}.bak-${Date.now()}`);
    } catch {
      // Couldn't move it aside; the atomic write below still replaces it.
    }
  }
  await writeTextFileAtomic(target, content);
  return existing !== null ? "replaced" : "written";
}

export interface CredentialPlacement {
  /** Validated path the importing tenant(s) should point at. */
  path: string;
  restored: boolean;
  note?: string;
  warning?: string;
}

/**
 * Put one embedded key file from a bundle onto this machine.
 *
 * A bundle's path is data, not an instruction: the only place a restore ever
 * writes is the credentials directory (see credentialFallbackDir). The
 * original path is honoured when it already points inside that directory,
 * so restoring onto the same layout is exact; anything else — a different
 * OS, a path elsewhere on the disk, a path that merely ends in `.json` — is
 * relocated into the directory and the tenant re-pointed automatically.
 * Name collisions with different content get a stable per-source-path
 * suffix, so re-importing the same bundle is idempotent.
 */
export async function placeCredentialFile(
  originalPath: string,
  validatedPath: string | null,
  content: string
): Promise<CredentialPlacement> {
  const dir = credentialFallbackDir();
  if (validatedPath && isInside(dir, validatedPath)) {
    try {
      const action = await writeKeyFile(validatedPath, content);
      return {
        path: validatedPath,
        restored: true,
        note:
          action === "replaced"
            ? `Key file ${validatedPath} differed — previous file kept as a .bak alongside it.`
            : undefined,
      };
    } catch {
      // Not writable here (missing mount, permissions) — relocate below.
    }
  }

  const base = safeBaseName(originalPath);
  let candidate = path.join(dir, base);
  try {
    if (readFileSync(candidate, "utf-8") !== content) {
      candidate = path.join(
        dir,
        `${base.replace(/\.json$/i, "")}-${shortHash(originalPath)}.json`
      );
    }
  } catch {
    // Nothing there yet — the plain basename is free.
  }

  let finalPath: string;
  try {
    finalPath = validateCredentialsFilePath(candidate);
  } catch (e) {
    return {
      path: candidate,
      restored: false,
      warning: `Could not restore the key file for ${originalPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  try {
    await writeKeyFile(finalPath, content);
    return {
      path: finalPath,
      restored: true,
      note: `Key file from ${originalPath} restored to ${finalPath} (restores only write inside the credentials directory).`,
    };
  } catch (e) {
    return {
      path: finalPath,
      restored: false,
      warning: `Could not write the key file for ${originalPath} to ${finalPath} — copy it there manually (${
        e instanceof Error ? e.message : String(e)
      }).`,
    };
  }
}
