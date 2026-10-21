import type { MetadataRoute } from "next";
import { TOOL_MANIFESTS } from "@sp/registry";
import { pageUrl } from "@/lib/seo";

export const dynamic = "force-static";

// Generated from the manifests, so a new tool is listed the build it appears. No lastModified:
// the build time would claim every page changed on every deploy.
export default function sitemap(): MetadataRoute.Sitemap {
  const page = (
    path: string,
    changeFrequency: "weekly" | "monthly" | "yearly",
    priority: number,
  ) => ({ url: pageUrl(path), changeFrequency, priority });

  return [
    page("/", "monthly", 1.0),
    page("/tools/", "weekly", 0.9),
    ...TOOL_MANIFESTS.map((m) => page(`/tools/${m.id}/`, "weekly", 0.85)),
    page("/padding-rules/", "monthly", 0.8),
    page("/limitations/", "monthly", 0.6),
    page("/privacy-policy/", "yearly", 0.5),
    page("/terms-conditions/", "yearly", 0.5),
    page("/disclaimer/", "yearly", 0.5),
    page("/cookie-policy/", "yearly", 0.5),
  ];
}
