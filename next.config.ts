import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone: a self-contained server plus only the node_modules
  // actually reachable at runtime. This is what the single-file desktop build
  // (see packaging/) embeds. `next dev` and `next start` are unaffected.
  output: "standalone",

  // The only <Image> in the app is the sidebar's SVG logo, which the image
  // optimizer passes through untouched. Turning optimization off lets the
  // packaged build ship without sharp's ~34 MB of platform-specific native
  // libraries — which would be the wrong platform's binaries anyway, since
  // the payload is built once and the exe runs on whatever Windows box gets it.
  images: { unoptimized: true },

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
    ],
  },
};

export default nextConfig;
