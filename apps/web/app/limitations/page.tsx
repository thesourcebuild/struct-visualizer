import Link from 'next/link';
import { LimitationsGuide } from '@/components/guides/LimitationsGuide';
import { pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata({
    path: '/limitations/',
    title: 'Limitations',
    description: 'What Struct Visualizer models and what it does not, for C/C++, Go and Rust.',
});

export default function LimitationsPage() {
    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
            <div className="container mx-auto max-w-4xl px-4 py-12 md:py-20">
                <div className="mb-12">
                    <h1 className="text-4xl md:text-5xl font-bold text-gray-900 dark:text-white">Limitations &amp; Disclaimers</h1>
                    <p className="text-lg text-gray-600 dark:text-gray-400 mt-4">
                        What this calculator models, what it approximates, and what it does not handle.
                    </p>
                </div>

                <LimitationsGuide />

                <div className="mt-12 text-center">
                    <Link
                        href="/tools/"
                        className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors"
                    >
                        ← Back to Calculator
                    </Link>
                </div>
            </div>
        </div>
    );
}
