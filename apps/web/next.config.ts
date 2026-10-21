import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// Single source of truth for the app version: the repo-root `version` file.
const version = readFileSync(resolve(process.cwd(), "../../version"), "utf8").trim();

// GitHub Pages serves project sites under /<repo>; set NEXT_PUBLIC_BASE_PATH=/<repo> in CI.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // The floating "N" dev badge sits over the sidebar's bottom-left corner.
  devIndicators: false,
  // next/font fetches Google Fonts at build time. Since Next 16.2, Turbopack verifies TLS with
  // the OS certificate store by default, so builds behind a TLS-inspecting proxy or antivirus
  // work without the former experimental.turbopackUseSystemTlsCerts flag.
  basePath,
  assetPrefix: basePath,
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  transpilePackages: [
    "@sp/contracts",
    "@sp/core",
    "@sp/engine",
    "@sp/go-layout",
    "@sp/layout",
    "@sp/platform",
    "@sp/registry",
    "@sp/rust-layout",
    "@sp/ui",
  ],
};

export default nextConfig;
