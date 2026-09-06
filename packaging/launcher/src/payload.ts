import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Where the bundled application archive comes from.
 *
 * In the shipped executable it is a Node single-executable-application asset.
 * When the bundle is run as an ordinary script (`node packaging/dist/launcher.cjs`,
 * which is how the build is debugged) it is the payload.zip sitting beside it.
 * Every SEA-specific detail lives here so the rest of the launcher stays
 * portable to another embedding mechanism.
 */

interface SeaModule {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
}

// `node:sea` is a built-in, so the resolution base is irrelevant; execPath is
// simply one that always exists.
const requireBuiltin = createRequire(process.execPath);

function seaModule(): SeaModule | null {
  try {
    return requireBuiltin("node:sea") as SeaModule;
  } catch {
    return null;
  }
}

/** True when running as the packaged single-file executable. */
export function isSea(): boolean {
  const sea = seaModule();
  try {
    return Boolean(sea?.isSea());
  } catch {
    return false;
  }
}

export const PAYLOAD_ASSET_NAME = "payload.zip";

export function loadPayload(): Uint8Array {
  const sea = seaModule();
  if (sea && sea.isSea()) return new Uint8Array(sea.getAsset(PAYLOAD_ASSET_NAME));

  // Not a packaged run: the archive sits beside the bundled script.
  const scriptDir = path.dirname(process.argv[1] ?? process.execPath);
  const beside = path.join(scriptDir, PAYLOAD_ASSET_NAME);
  if (!fs.existsSync(beside)) {
    throw new Error(
      `no embedded application payload, and none found at ${beside}. ` +
        `Run "npm run package" first.`
    );
  }
  return new Uint8Array(fs.readFileSync(beside));
}
