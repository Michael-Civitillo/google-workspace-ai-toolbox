import path from "node:path";

/**
 * Base directory for everything Open Admin persists locally: tenants.json,
 * app-config.json, sso.json, audit.log, and credential files relocated by a
 * configuration import.
 *
 * Defaults to the process working directory, so `npm run dev` and
 * `npm start` keep writing next to the project exactly as before.
 *
 * The packaged desktop build (single .exe) sets OPEN_ADMIN_DATA_DIR to a
 * per-user application-data folder. It has to: the Next.js standalone server
 * chdir()s into the extracted application directory, which is versioned and
 * deleted on upgrade — state written there would silently disappear.
 */
export function dataDir(): string {
  const configured = process.env.OPEN_ADMIN_DATA_DIR?.trim();
  return path.resolve(configured || process.cwd());
}

/** Join `segments` onto the data directory. */
export function dataPath(...segments: string[]): string {
  return path.join(dataDir(), ...segments);
}
