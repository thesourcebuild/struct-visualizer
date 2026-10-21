import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const WEB_FILES = ["apps/web/**/*.{js,jsx,mjs,ts,tsx}"];

// Logic packages also run in Node (tests) and must stay host-agnostic.
const PURE_PACKAGES = ["packages/core/**", "packages/engine/**", "packages/tools/**"];

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/.next/**",
    "**/out/**",
    "**/.turbo/**",
    "**/next-env.d.ts",
    ".test-dist/**",
  ]),

  // Next's rules (react, react-hooks, a11y, @next/next) apply only to the web app.
  ...nextVitals.map((c) => ({ ...c, files: c.files ?? WEB_FILES })),
  { settings: { next: { rootDir: "apps/web/" } } },

  ...nextTs,

  {
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },

  {
    files: PURE_PACKAGES,
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "window", message: "Pure packages must not touch the DOM." },
        { name: "document", message: "Pure packages must not touch the DOM." },
        { name: "localStorage", message: "Use @sp/platform from the web app instead." },
        { name: "navigator", message: "Pure packages must not touch the DOM." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Results must be deterministic." },
      ],
      "no-console": "error",
    },
  },
]);
