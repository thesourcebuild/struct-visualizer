import Link from 'next/link';
import { PaddingRulesGuide } from '@/components/guides/PaddingRulesGuide';
import { JsonLd } from '@/components/seo/JsonLd';
import { breadcrumbs, pageMetadata, pageUrl } from '@/lib/seo';

const TITLE = 'Struct Padding Rules & Memory Alignment Guide';
const DESCRIPTION =
  'How C/C++ compilers align and pad struct members: alignment rules, padding, the effect of the architecture, and tips for a smaller layout.';

export const metadata = pageMetadata({ path: '/padding-rules/', title: TITLE, description: DESCRIPTION });

export default function PaddingRulesPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-900 dark:to-blue-950 p-6 md:p-8">
      <JsonLd
        data={{
          '@graph': [
            {
              '@type': 'TechArticle',
              headline: TITLE,
              description: DESCRIPTION,
              url: pageUrl('/padding-rules/'),
              author: { '@type': 'Person', name: 'Muhammad Hassaan Shah', url: 'https://github.com/thesourcebuild' },
              datePublished: '2026-02-05',
            },
            breadcrumbs([{ name: 'Padding Rules', path: '/padding-rules/' }]),
          ],
        }}
      />

      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <Link
            href="/tools/"
            className="inline-flex items-center gap-2 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors font-medium"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Calculator
          </Link>
        </div>

        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-50 mb-2">Struct Padding Rules</h1>
          <p className="text-lg text-gray-600 dark:text-gray-400">
            Practical guidance for C/C++ struct layout, alignment, and ABI-driven padding behavior
          </p>
        </div>

        <div className="space-y-8">
          <PaddingRulesGuide />

          <div className="mt-12 pt-8 border-t border-gray-200 dark:border-gray-700">
            <Link
              href="/tools/"
              className="inline-flex items-center gap-2 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-semibold transition-colors"
            >
              Back to Calculator
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
