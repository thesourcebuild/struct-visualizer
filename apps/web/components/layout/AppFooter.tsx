import Link from 'next/link';
import { cn } from '@sp/ui';
import { APP_VERSION, GITHUB_URL, SITE_TITLE } from '@/lib/constants';
import CookieSettingsButton from '@/components/ui/CookieSettingsButton';

const COPYRIGHT_HOLDER = 'Muhammad Hassaan Shah';

/** Where to read more and where to report a problem. Only when the repository is known. */
const PROJECT_LINKS: readonly { label: string; href: string; title: string; accent?: boolean }[] = GITHUB_URL
    ? [
          { label: 'Docs', href: `${GITHUB_URL}#readme`, title: 'What each language supports and how results are checked' },
          { label: 'GitHub', href: GITHUB_URL, title: 'Source and release notes' },
          {
              // The one link that asks something of the reader, so the only one coloured as a link.
              accent: true,
              label: 'Report an issue',
              href: `${GITHUB_URL}/issues/new`,
              title: 'A layout that disagrees with your compiler, or a control that does nothing',
          },
      ]
    : [];

const LEGAL = [
    { href: '/terms-conditions/', label: 'Terms' },
    { href: '/privacy-policy/', label: 'Privacy' },
    { href: '/cookie-policy/', label: 'Cookies' },
    { href: '/disclaimer/', label: 'Disclaimer' },
];

const LINK = 'rounded transition-colors hover:text-gray-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:hover:text-gray-100';

/** A thin bar at the end of the page: what this is, and where to go about it. */
export default function AppFooter() {
    return (
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-gray-200 px-4 py-2 text-[11px] text-gray-500 sm:px-6 lg:px-8 dark:border-gray-800 dark:text-gray-400">
            <p className="flex items-center gap-2">
                <span className="font-medium text-gray-600 dark:text-gray-300">{SITE_TITLE}</span>
                <span>v{APP_VERSION}</span>
                <Separator />
                <span>
                    © {new Date().getFullYear()} {COPYRIGHT_HOLDER}
                </span>
            </p>

            <nav aria-label="Footer" className="flex flex-wrap items-center gap-2">
                {PROJECT_LINKS.map((link) => (
                    <span key={link.href} className="flex items-center gap-2">
                        <a
                            href={link.href}
                            title={link.title}
                            target="_blank"
                            rel="noreferrer noopener"
                            className={cn(
                                LINK,
                                link.accent &&
                                    'text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300',
                            )}
                        >
                            {link.label}
                        </a>
                        <Separator />
                    </span>
                ))}
                {LEGAL.map((l, index) => (
                    <span key={l.href} className="flex items-center gap-2">
                        {index > 0 && <Separator />}
                        <Link href={l.href} className={LINK}>
                            {l.label}
                        </Link>
                    </span>
                ))}
                <Separator />
                <CookieSettingsButton className={LINK} />
            </nav>
        </footer>
    );
}

/** The pipe between groups. `aria-hidden`: it is punctuation. */
function Separator() {
    return (
        <span aria-hidden="true" className="text-gray-300 dark:text-gray-700">
            |
        </span>
    );
}
