import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TOOL_MANIFESTS, getManifest } from "@sp/registry";
import { JsonLd } from "@/components/seo/JsonLd";
import { SITE_TITLE } from "@/lib/constants";
import { breadcrumbs, pageMetadata, pageUrl } from "@/lib/seo";
import { AppShell } from "../../workbench/app-shell";

// One static page per tool, for SEO and deep links; the shell takes over client-side.
export const dynamicParams = false;

export function generateStaticParams() {
  return TOOL_MANIFESTS.map((m) => ({ tool: m.id }));
}

type Props = { params: Promise<{ tool: string }> };

// The summary says what the tool does; the suffix is what a searcher is deciding on, added when
// it fits in the ~160 characters a search result shows.
const SUFFIX = " Runs in your browser; nothing is uploaded.";
const description = (summary: string) => (summary.length + SUFFIX.length <= 160 ? summary + SUFFIX : summary);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const manifest = getManifest((await params).tool);
  if (!manifest) return {};
  return pageMetadata({
    path: `/tools/${manifest.id}/`,
    title: manifest.label,
    description: description(manifest.summary),
    keywords: manifest.tags,
  });
}

export default async function ToolPage({ params }: Props) {
  const manifest = getManifest((await params).tool);
  if (!manifest) notFound();
  const path = `/tools/${manifest.id}/`;

  return (
    <>
      <JsonLd
        data={{
          "@graph": [
            {
              "@type": "SoftwareApplication",
              name: manifest.label,
              url: pageUrl(path),
              description: description(manifest.summary),
              applicationCategory: "DeveloperApplication",
              operatingSystem: "Any",
              isAccessibleForFree: true,
              offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
              isPartOf: { "@type": "WebApplication", name: SITE_TITLE, url: pageUrl("/") },
            },
            breadcrumbs([
              { name: "Tools", path: "/tools/" },
              { name: manifest.label, path },
            ]),
          ],
        }}
      />
      <AppShell initialToolId={manifest.id} />
    </>
  );
}
