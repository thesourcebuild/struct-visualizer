import type { MetadataRoute } from "next";
import { assetPath, pageUrl } from "@/lib/seo";

export const dynamic = "force-static";

// Crawlers only read robots.txt at the origin root, so on a GitHub Pages project site this file is
// inert and the sitemap has to be submitted in Search Console. It is right as soon as the site moves
// to its own domain. Hashed build chunks are not worth a crawler's budget.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: assetPath("/_next/") }],
    sitemap: pageUrl("/sitemap.xml"),
  };
}
