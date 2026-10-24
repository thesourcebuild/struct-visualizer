import type { Metadata } from 'next';
import { BASE_PATH, SITE_TITLE, SITE_URL } from './constants';

/**
 * Absolute URL of a page, e.g. pageUrl('/tools/struct-layout/'). Paths end in "/" to match
 * `trailingSlash: true`.
 *
 * Canonical and Open Graph URLs are always written absolute: a relative one beginning with "/"
 * resolves against the origin and drops the GitHub Pages sub-path, pointing every page at another site.
 */
export function pageUrl(path: string): string {
    return `${SITE_URL}${path}`;
}

/** A path inside the site for `<link>` hrefs, which Next does not prefix with the base path. */
export function assetPath(path: string): string {
    return `${BASE_PATH}${path}`;
}

// Served by app/og-image.png/route.tsx as a real .png file. Next's opengraph-image convention
// exports an extensionless file, which static hosts do not serve as an image.
export const OG_IMAGE = {
    url: pageUrl('/og-image.png'),
    width: 1200,
    height: 630,
    alt: `${SITE_TITLE}: memory layout and padding for C/C++, Go, Rust and Zig`,
} as const;

/**
 * The metadata every indexable page needs: its own title, description and canonical, and complete
 * Open Graph and Twitter cards. A page's `openGraph` replaces the root layout's whole object rather
 * than merging into it, so the image and URL are repeated here instead of inherited.
 *
 * `title` is the page's own name; the root layout's template adds " | Struct Visualizer". Pass
 * `absoluteTitle` for the home page, whose title is used as is.
 */
export function pageMetadata({
    path,
    title,
    description,
    keywords,
    absoluteTitle = false,
}: {
    path: string;
    title: string;
    description: string;
    keywords?: readonly string[];
    absoluteTitle?: boolean;
}): Metadata {
    const fullTitle = absoluteTitle ? title : `${title} | ${SITE_TITLE}`;
    const url = pageUrl(path);
    return {
        title: absoluteTitle ? { absolute: title } : title,
        description,
        ...(keywords && { keywords: [...keywords] }),
        alternates: { canonical: url },
        openGraph: {
            type: 'website',
            url,
            siteName: SITE_TITLE,
            title: fullTitle,
            description,
            locale: 'en_US',
            images: [OG_IMAGE],
        },
        twitter: {
            card: 'summary_large_image',
            title: fullTitle,
            description,
            images: [OG_IMAGE.url],
        },
    };
}

/** A BreadcrumbList from the home page down to `trail`'s last entry. */
export function breadcrumbs(trail: readonly { name: string; path: string }[]) {
    return {
        '@type': 'BreadcrumbList',
        itemListElement: [{ name: SITE_TITLE, path: '/' }, ...trail].map((item, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: item.name,
            item: pageUrl(item.path),
        })),
    };
}
