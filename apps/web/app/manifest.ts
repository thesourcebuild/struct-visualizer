import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/lib/constants";
import { assetPath } from "@/lib/seo";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_TITLE,
    short_name: SITE_TITLE,
    description: SITE_DESCRIPTION,
    start_url: assetPath("/tools/"),
    scope: assetPath("/"),
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#2563eb",
    icons: [
      { src: assetPath("/icon.svg"), type: "image/svg+xml", sizes: "any" },
      { src: assetPath("/logo-512.png"), type: "image/png", sizes: "512x512" },
      { src: assetPath("/apple-touch-icon.png"), type: "image/png", sizes: "180x180" },
    ],
  };
}
