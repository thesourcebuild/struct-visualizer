import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppHeader from "@/components/layout/AppHeader";
import AppFooter from "@/components/layout/AppFooter";
import CookieConsent from "@/components/ui/CookieConsent";
import ScrollControls from "@/components/ui/ScrollControls";
import { GuideOverlayHost } from "@/components/guides/guide-overlay";
import { JsonLd } from "@/components/seo/JsonLd";
import { SITE_DESCRIPTION, SITE_KEYWORDS, SITE_SUMMARY, SITE_TITLE, SITE_URL } from "@/lib/constants";
import { OG_IMAGE, assetPath, pageUrl } from "@/lib/seo";
import { THEME_INIT_SCRIPT } from "./theme-constants";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Site-wide defaults. There is deliberately no canonical here: every page sets its own through
// pageMetadata(), and an inherited one would mark the page as a duplicate of the home page.
export const metadata: Metadata = {
  metadataBase: new URL(`${SITE_URL}/`),
  title: {
    default: `${SITE_TITLE} | Memory Layout Visualizer & Struct Padding Calculator`,
    template: `%s | ${SITE_TITLE}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_TITLE,
  keywords: [...SITE_KEYWORDS],
  authors: [{ name: "Muhammad Hassaan Shah", url: "https://github.com/thesourcebuild" }],
  creator: "TheSourceBuild",
  category: "developer tools",
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
  openGraph: {
    type: "website",
    siteName: SITE_TITLE,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: "en_US",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE.url],
  },
  icons: {
    icon: [
      { url: assetPath("/icon.svg"), type: "image/svg+xml" },
      { url: assetPath("/logo-512.png"), type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: assetPath("/apple-touch-icon.png"), type: "image/png", sizes: "180x180" }],
  },
  // iOS Safari turns digit runs into tel: links, and offsets and sizes are full of them.
  formatDetection: { telephone: false, date: false, address: false, email: false },
};

export const viewport: Viewport = {
  themeColor: "#2563eb",
};

// The site as a whole; each tool page adds a SoftwareApplication that is part of it.
const WEB_APPLICATION = {
  "@type": "WebApplication",
  name: SITE_TITLE,
  url: pageUrl("/"),
  description: SITE_SUMMARY,
  image: OG_IMAGE.url,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any",
  browserRequirements: "Requires JavaScript. Runs entirely in the browser; nothing is uploaded.",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author: { "@type": "Person", name: "Muhammad Hassaan Shah", url: "https://github.com/thesourcebuild" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the saved theme before first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <JsonLd data={WEB_APPLICATION} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen flex flex-col`}
      >
        <AppHeader />
        <main className="flex-1">{children}</main>
        <AppFooter />
        <CookieConsent />
        <ScrollControls />
        <GuideOverlayHost />
      </body>
    </html>
  );
}
