import fs from "node:fs";
import path from "node:path";
import { isOwnerOnly } from "./fsutil.ts";

/**
 * The data folder holds the sign-in password, the session secret, the
 * instance token, Gemini and single sign-on secrets and service-account keys.
 * On macOS and Linux it is created for its owner only and tightened if it was
 * left open; on Windows its protection is the user profile's permissions, so
 * the person is told when it lies outside the profile.
 */

export interface DataDirInputs {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The current user's id on macOS and Linux. */
  uid?: number | null;
}

/** Messages worth showing about the folder, after it has been made ready. */
export interface DataDirReport {
  info: string[];
  warnings: string[];
}

/** True when `dir` is `parent` or inside it (Windows rules: any case, either slash). */
export function isInsideWindowsFolder(dir: string, parent: string): boolean {
  const relative = path.win32.relative(parent, dir);
  return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
}

/** Create the data folder if needed and check who else can get into it. */
export function prepareDataDir(dir: string, inputs: DataDirInputs = {}): DataDirReport {
  const platform = inputs.platform ?? process.platform;
  const env = inputs.env ?? process.env;
  const uid = inputs.uid !== undefined ? inputs.uid : typeof process.getuid === "function" ? process.getuid() : null;
  const report: DataDirReport = { info: [], warnings: [] };

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (platform === "win32") {
    const profile = env.USERPROFILE;
    if (profile && !isInsideWindowsFolder(path.win32.resolve(dir), path.win32.resolve(profile))) {
      report.warnings.push(
        `The data folder ${dir} is outside your user profile (${profile}), so Windows ` +
          `may let other people on this computer or network read the sign-in password ` +
          `and keys kept in it. Keep it somewhere only you can open.`
      );
    }
    return report;
  }

  const stat = fs.statSync(dir);
  if (!isOwnerOnly(stat.mode)) {
    if (uid !== null && stat.uid === uid) {
      try {
        fs.chmodSync(dir, 0o700);
        report.info.push(`Made the data folder ${dir} private to you: other users could open it.`);
      } catch {
        report.warnings.push(
          `Other users can open the data folder ${dir}, and its permissions could not be ` +
            `changed (this drive may not support them). Keep it somewhere only you can open.`
        );
      }
    } else {
      report.warnings.push(
        `Other users can open the data folder ${dir}, which belongs to someone else. ` +
          `Use a folder of your own (--data-dir) that only you can open.`
      );
    }
  }

  // Usually written by hand in an editor, which leaves it readable by
  // everyone; it may hold keys, and it changes how Open Admin runs.
  const envFile = path.join(dir, "launcher.env");
  let envStat: fs.Stats | null = null;
  try {
    envStat = fs.statSync(envFile);
  } catch {
    // No launcher.env: nothing to check.
  }
  if (envStat && !isOwnerOnly(envStat.mode)) {
    let fixed = false;
    if (uid !== null && envStat.uid === uid) {
      try {
        fs.chmodSync(envFile, 0o600);
        fixed = true;
        report.info.push("Made launcher.env private to you: other users could read it.");
      } catch {
        // Reported below.
      }
    }
    if (!fixed) {
      report.warnings.push(
        `launcher.env can be read by other users on this machine. It may hold keys, and ` +
          `it changes how Open Admin runs: make it private to you (chmod 600 "${envFile}").`
      );
    }
  }
  return report;
}
