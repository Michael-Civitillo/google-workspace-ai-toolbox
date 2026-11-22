import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Packaging tooling: not a Next.js surface, and it has its own tsconfig
    // and node --test suite (npm run test:launcher).
    "packaging/**",
  ]),
  {
    // eslint-config-next 16.4 turns on three rules written for the React
    // Compiler, which this app does not use. The patterns they flag are
    // deliberate here: clearing a page's state in an effect when the tenant
    // changes, and keeping the live tenant id in a ref that async work checks
    // after each await. Kept visible as warnings rather than rewritten.
    // Only where eslint-config-next registers the react-hooks plugin: on any
    // other file (a .cjs script) the rule names would not resolve.
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
]);

export default eslintConfig;
