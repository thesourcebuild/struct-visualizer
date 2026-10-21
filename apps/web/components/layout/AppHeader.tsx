'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SITE_TITLE, GITHUB_URL } from '@/lib/constants';
import ThemeToggle from '@/components/ui/ThemeToggle';
import ScrollProgress from '@/components/ui/ScrollProgress';
import { SettingsOverlay } from '@/app/workbench/settings-overlay';
import { openGuide } from '@/components/guides/guide-overlay';
import type { GuideId } from '@/components/guides/guide-overlay';

/** Shared style for the square icon buttons on the right, so all three match exactly. */
export const HEADER_ICON_BUTTON =
    'inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white';

interface NavEntry {
    href: string;
    label: string;
    match: (pathname: string) => boolean;
    /** Guides open in the overlay instead of navigating, so you never lose your place. */
    guide?: GuideId;
}

const NAV: readonly NavEntry[] = [
    { href: '/tools/', label: 'Calculator', match: (p) => p.startsWith('/tools') },
    { href: '/padding-rules/', label: 'Padding Rules', match: (p) => p.startsWith('/padding-rules'), guide: 'padding-rules' },
    { href: '/limitations/', label: 'Limitations', match: (p) => p.startsWith('/limitations'), guide: 'limitations' },
];

const NAV_ITEM = {
    desktop: 'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
    mobile: 'block w-full rounded-md px-3 py-2 text-left text-sm font-medium',
};
const NAV_ACTIVE = 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white';
const NAV_IDLE =
    'text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/60 dark:hover:text-white';

/**
 * A guide entry is a button that opens the overlay -- except on the guide's own page, where an
 * overlay of the page you are reading would be pointless, so it stays a highlighted link.
 */
function NavItem({ item, pathname, variant, onDone }: {
    item: NavEntry;
    pathname: string;
    variant: 'desktop' | 'mobile';
    onDone?: () => void;
}) {
    const active = item.match(pathname);
    const className = `${NAV_ITEM[variant]} ${active ? NAV_ACTIVE : NAV_IDLE}`;
    if (item.guide && !active) {
        const guide = item.guide;
        return (
            <button
                type="button"
                aria-haspopup="dialog"
                className={className}
                onClick={() => {
                    onDone?.();
                    openGuide(guide);
                }}
            >
                {item.label}
            </button>
        );
    }
    return (
        <Link href={item.href} onClick={onDone} aria-current={active ? 'page' : undefined} className={className}>
            {item.label}
        </Link>
    );
}

function LogoMark() {
    return (
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm">
            <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="M3 12h18M9 5v14M15 12v7" />
            </svg>
        </span>
    );
}

export default function AppHeader() {
    const pathname = usePathname();
    const onCalculator = pathname.startsWith('/tools');
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);

    return (
        <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/90 backdrop-blur supports-backdrop-filter:bg-white/75 dark:border-gray-800 dark:bg-gray-900/90 dark:supports-backdrop-filter:bg-gray-900/75">
            {/* Three columns (1fr auto 1fr) keep the nav centered on the page whatever the widths of
                the logo and the controls on either side. */}
            <div className="grid h-14 w-full grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 sm:px-6 lg:px-8">
                <Link href="/" className="flex min-w-0 items-center gap-2.5 justify-self-start" aria-label={`${SITE_TITLE} home`}>
                    <LogoMark />
                    <span className="hidden truncate text-[15px] font-semibold tracking-tight text-gray-900 sm:block dark:text-white">
                        {SITE_TITLE}
                    </span>
                </Link>

                {/* Always rendered, so the grid keeps three columns when the nav is hidden on mobile. */}
                <div className="justify-self-center">
                    <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
                        {NAV.map((item) => (
                            <NavItem key={item.href} item={item} pathname={pathname} variant="desktop" />
                        ))}
                    </nav>
                </div>

                <div className="flex items-center gap-1 justify-self-end">
                    {!onCalculator && (
                        <Link
                            href="/tools/"
                            className="mr-2 inline-flex h-9 items-center whitespace-nowrap rounded-lg bg-blue-600 px-3.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700"
                        >
                            <span className="sm:hidden">Calculator</span>
                            <span className="hidden sm:inline">Open calculator</span>
                        </Link>
                    )}
                    {GITHUB_URL && (
                    <a
                        href={GITHUB_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={HEADER_ICON_BUTTON}
                        title="Source on GitHub"
                    >
                        <svg className="h-4.5 w-4.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                            <path
                                fillRule="evenodd"
                                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                                clipRule="evenodd"
                            />
                        </svg>
                        <span className="sr-only">GitHub</span>
                    </a>
                    )}
                    <ThemeToggle className={HEADER_ICON_BUTTON} />
                    <button
                        type="button"
                        onClick={() => setSettingsOpen(true)}
                        className={HEADER_ICON_BUTTON}
                        title="Settings"
                    >
                        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                        <span className="sr-only">Settings</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => setMenuOpen((o) => !o)}
                        aria-expanded={menuOpen}
                        aria-controls="mobile-nav"
                        className={`${HEADER_ICON_BUTTON} md:hidden`}
                        title="Menu"
                    >
                        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
                            {menuOpen ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
                        </svg>
                        <span className="sr-only">Menu</span>
                    </button>
                </div>
            </div>
            {menuOpen && (
                <nav id="mobile-nav" aria-label="Main" className="border-t border-gray-200 px-4 py-2 md:hidden dark:border-gray-800">
                    {NAV.map((item) => (
                        <NavItem
                            key={item.href}
                            item={item}
                            pathname={pathname}
                            variant="mobile"
                            onDone={() => setMenuOpen(false)}
                        />
                    ))}
                </nav>
            )}
            <ScrollProgress height={2} />
            <SettingsOverlay open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </header>
    );
}
