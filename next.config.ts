import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";

// The folder this file is in, which is the project. Next compiles this file to
// CommonJS and evaluates it as if it sat in the project folder, so __dirname
// is that folder; the fallback covers Node's own TypeScript loader, where the
// file runs as an ES module and Next is started from the project folder.
const projectDir = typeof __dirname === "string" ? __dirname : process.cwd();

// The version in package.json, made available to the app as it is built. It
// is what App Settings shows and what the optional update check compares
// against the newest release.
const { version } = JSON.parse(
  readFileSync(path.join(projectDir, "package.json"), "utf-8")
) as {
  version: string;
};

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_APP_VERSION: version },

  // Emit .next/standalone: a self-contained server plus only the node_modules
  // actually reachable at runtime. This is what the single-file desktop build
  // (see packaging/) embeds. `next dev` and `next start` are unaffected.
  output: "standalone",

  // The root the file tracer works from, pinned to this project. Left to
  // itself, Next picks the highest folder with a lockfile, so a checkout
  // inside another project (or under a home folder with a stray
  // package-lock.json) gets its standalone output nested under that parent,
  // copies of the parent's files included. scripts/prune-standalone.mjs fails
  // the build if server.js is not at the top of the output.
  outputFileTracingRoot: projectDir,
  turbopack: { root: projectDir },

  // The only <Image> in the app is the sidebar's SVG logo, which the image
  // optimizer passes through untouched. Turning optimization off lets the
  // packaged build ship without sharp's ~34 MB of platform-specific native
  // libraries — which would be the wrong platform's binaries anyway, since
  // the payload is built once and the exe runs on whatever Windows box gets it.
  images: { unoptimized: true },

  // Don't advertise the framework, and don't reserve a 50 MB in-memory cache
  // for an app that has no incrementally regenerated pages.
  poweredByHeader: false,
  cacheMaxMemorySize: 0,

  experimental: {
    // By default the production server requires every page and route entry
    // at boot. For an admin tool that idles most of the day that is ~65 MB of
    // resident memory holding code nobody has asked for yet (measured: 164 MB
    // idle → 97 MB). Loading an entry on its first request costs 40–110 ms,
    // once.
    preloadEntriesOnStart: false,
  },

  // The config-import feature writes operator-supplied key file paths, so the
  // file tracer can't prove which paths are reachable and conservatively pulls
  // the whole project into the standalone output (it warns about this at build
  // time). None of it is needed to serve requests — the app is compiled into
  // .next/server — so exclude the source, docs and tooling explicitly, along
  // with sharp per the note above.
  outputFileTracingExcludes: {
    "*": [
      "node_modules/sharp/**",
      "node_modules/@img/**",
      "src/**",
      "docs/**",
      "scripts/**",
      "packaging/**",
      "*.md",
      "eslint.config.mjs",
      "postcss.config.mjs",
      "components.json",
      "tsconfig.json",
      "tsconfig.tsbuildinfo",
      "package-lock.json",
      // Local state lives in the working directory by default and the tracer
      // resolves the store paths to real files: a build on a machine that has
      // run the app copies its tenants, single sign-on config, audit log and
      // service-account keys into the standalone output — and from there into a
      // Docker image or the packaged executable.
      //
      // These patterns are NOT what actually prevents that: a Turbopack build
      // (the default since Next 16) ignores outputFileTracingExcludes, and a
      // build with dummy state in the working directory copies all of it even
      // with the list below. scripts/prune-standalone.mjs, which `npm run
      // build` runs afterwards, is the guarantee — it keeps only what the
      // server runs from, deletes everything else whatever its name, and fails
      // the build if anything else is left. The list stays for the webpack
      // path and as a statement of intent.
      "tenants.json*",
      "sso.json*",
      "app-config.json*",
      "delegation-sightings.json*",
      "security-check-history.json*",
      "session-secret",
      "audit.log",
      "credentials/**",
    ],
  },
};

export default nextConfig;
