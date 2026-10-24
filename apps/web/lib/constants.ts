// Site constants
export const SITE_TITLE = 'Struct Visualizer';
// The meta description: under 160 characters, which is about where a search result cuts it off.
export const SITE_DESCRIPTION =
    'See every byte of a C/C++, Go, Rust or Zig type: offsets, padding, alignment and the field order that saves space, on desktop and embedded targets.';
// The longer form, for structured data, where nothing truncates it.
export const SITE_SUMMARY =
    'Struct padding calculator and memory layout visualizer for C/C++, Go, Rust and Zig: offsets, padding, alignment and the optimal field order, on x86, x64, ARM, RISC-V, WebAssembly and AVR, PIC and 8051 microcontrollers. Checked against GCC, MSVC, the Go compiler, rustc and zig.';
export const SITE_KEYWORDS = [
    'struct padding',
    'struct padding calculator',
    'memory layout',
    'data alignment',
    'C struct layout',
    'C++ struct',
    'Go struct alignment',
    'Rust type layout',
    'Zig struct layout',
    'sizeof offsetof',
    'struct optimization',
    'embedded systems',
    'microcontroller',
    'x86',
    'ARM',
    'RISC-V',
    'AVR',
    'PIC',
    '8051',
];
// The source repository, set by the deploy workflow (NEXT_PUBLIC_GITHUB_URL). Undefined in builds
// without it, which then show no source link rather than one to github.com's front page.
export const GITHUB_URL: string | undefined = process.env.NEXT_PUBLIC_GITHUB_URL || undefined;
// Deployment sub-path (GitHub Pages project sites), e.g. "/struct-visualizer". Empty at a domain root.
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/$/, '');
// Absolute URL of the site root, sub-path included, for canonical links, Open Graph, the sitemap
// and structured data. NEXT_PUBLIC_SITE_URL is the origin (the deploy workflow passes
// https://<owner>.github.io); one that already ends in the sub-path is accepted as well.
const SITE_ORIGIN = (process.env.NEXT_PUBLIC_SITE_URL || 'https://structvisualizer.com').replace(/\/$/, '');
export const SITE_URL = BASE_PATH && !SITE_ORIGIN.endsWith(BASE_PATH) ? `${SITE_ORIGIN}${BASE_PATH}` : SITE_ORIGIN;
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0';
export const SUPPORTED_ARCHITECTURES = [
    'x86',
    'x64',
    'ARM32',
    'ARM64',
    '8051',
    'AVR',
    'PIC microcontrollers',
    'RISC-V',
];
// Default scroll threshold (px) used by scroll helpers (show/hide controls)
export const SCROLL_THRESHOLD = 80;
