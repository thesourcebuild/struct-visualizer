import type { ComponentType } from "react";
import type { Metadata } from "next";
import { getManifest } from "@sp/registry";
import type { ToolManifest } from "@sp/engine";
import { JsonLd } from "@/components/seo/JsonLd";
import { SITE_TITLE } from "@/lib/constants";
import { breadcrumbs, pageMetadata, pageUrl } from "@/lib/seo";
import type { AppShellProps } from "../workbench/app-shell";

/**
 * Shared by the per-tool routes (app/tools/<id>/page.tsx). Each tool has its own route file rather
 * than one dynamic [tool] route because Next.js bundles per route: a route file that imports only
 * its own language's shell is the only way a page loads only that language's code up front.
 * tests/tool-routes.test.ts checks every registered tool has one, with the right shell.
 */

function requireManifest(id: string): ToolManifest {
  const manifest = getManifest(id);
  if (!manifest) throw new Error(`No tool registered with id '${id}'`);
  return manifest;
}

// The summary says what the tool does; the suffix is what a searcher is deciding on, added when
// it fits in the ~160 characters a search result shows.
const SUFFIX = " Runs in your browser; nothing is uploaded.";
const description = (summary: string) => (summary.length + SUFFIX.length <= 160 ? summary + SUFFIX : summary);

export function toolMetadata(id: string): Metadata {
  const manifest = requireManifest(id);
  return pageMetadata({
    path: `/tools/${manifest.id}/`,
    title: manifest.label,
    description: description(manifest.summary),
    keywords: manifest.tags,
  });
}

export function ToolPage({ id, Shell }: { id: string; Shell: ComponentType<AppShellProps> }) {
  const manifest = requireManifest(id);
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
      <Shell initialToolId={manifest.id} />
    </>
  );
}
