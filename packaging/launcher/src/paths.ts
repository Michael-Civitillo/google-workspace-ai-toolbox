import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Where the packaged build keeps things.
 *
 *   <root>/app/<version>-<hash>/   extracted application, disposable
 *   <root>/data/                   everything the operator would miss
 *
 * Two roots are possible. Normally <root> is the per-user application-data
 * folder, so the exe can live in Downloads and be replaced freely. In
 * "portable" mode — a `portable.txt` file or an existing `data` folder beside
 * the executable — <root> is the executable's own folder, which is what makes
 * a USB stick or a shared network folder work.
 */

export const APP_FOLDER_NAME = "GoogleWorkspaceOpenAdmin";

export interface PathInputs {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** Directory holding the running executable. */
  exeDir: string;
  /** --root, if given. */
  rootFlag?: string | null;
  /** --data-dir, if given. */
  dataDirFlag?: string | null;
  /** Injectable for tests. */
  exists?: (p: string) => boolean;
}

export interface ResolvedPaths {
  root: string;
  appRoot: string;
  dataDir: string;
  portable: boolean;
}

/** Per-user application-data folder for this OS. */
export function defaultRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(homedir, "AppData", "Local");
    return path.join(local, APP_FOLDER_NAME);
  }
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", APP_FOLDER_NAME);
  }
  const xdg = env.XDG_DATA_HOME || path.join(homedir, ".local", "share");
  return path.join(xdg, APP_FOLDER_NAME);
}

/** True when the executable's own folder should hold app + data. */
export function isPortableLayout(
  exeDir: string,
  exists: (p: string) => boolean
): boolean {
  return exists(path.join(exeDir, "portable.txt")) || exists(path.join(exeDir, "data"));
}

export function resolvePaths(input: PathInputs): ResolvedPaths {
  const exists = input.exists ?? ((p: string) => fs.existsSync(p));
  const portable = !input.rootFlag && isPortableLayout(input.exeDir, exists);

  const root = input.rootFlag
    ? path.resolve(input.rootFlag)
    : portable
    ? input.exeDir
    : defaultRoot(input.platform, input.env, input.homedir);

  const dataDir = input.dataDirFlag
    ? path.resolve(input.dataDirFlag)
    : input.env.OPEN_ADMIN_DATA_DIR?.trim()
    ? path.resolve(input.env.OPEN_ADMIN_DATA_DIR.trim())
    : path.join(root, "data");

  return { root, appRoot: path.join(root, "app"), dataDir, portable };
}

/** Directory name for one payload: version plus a short content hash. */
export function appDirFor(appRoot: string, version: string, hash: string): string {
  return path.join(appRoot, `${version}-${hash.slice(0, 12)}`);
}

/** Convenience wrapper around resolvePaths for the real process. */
export function resolvePathsForProcess(
  rootFlag: string | null,
  dataDirFlag: string | null
): ResolvedPaths {
  return resolvePaths({
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    exeDir: path.dirname(process.execPath),
    rootFlag,
    dataDirFlag,
  });
}
