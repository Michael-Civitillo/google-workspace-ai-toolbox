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
  /**
   * Node 22+: a view over the bytes embedded in the executable, without the
   * copy getAsset makes. Read-only by contract; the launcher only reads.
   */
  getRawAsset?(key: string): ArrayBuffer | Uint8Array;
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

/**
 * The archive bytes. Only called when an extraction is actually needed: the
 * app directory is keyed by the hash baked in at build time, so a launch that
 * finds it already unpacked never loads the payload at all.
 */
export function loadPayload(): Uint8Array {
  const sea = seaModule();
  if (sea && sea.isSea()) {
    const raw =
      sea.getRawAsset?.(PAYLOAD_ASSET_NAME) ?? sea.getAsset(PAYLOAD_ASSET_NAME);
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  }

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
