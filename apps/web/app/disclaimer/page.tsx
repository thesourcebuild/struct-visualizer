import { SITE_TITLE } from '@/lib/constants';
import { pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata({
    path: '/disclaimer/',
    title: 'Disclaimer',
    description: 'Struct Visualizer models compilers rather than running them: confirm results with the generated verification code.',
});

export default function Disclaimer() {
    return (
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-8">Disclaimer</h1>

            <div className="space-y-8 text-gray-700 dark:text-gray-300">
                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">General Disclaimer</h2>
                    <p>
                        The {SITE_TITLE} is provided &quot;as-is&quot; for educational and informational purposes only. While we strive to provide accurate and up-to-date information, we make no representations or warranties of any kind, express or implied, about the completeness, accuracy, reliability, suitability, or availability with respect to the calculator or the information, products, services, or related graphics contained on the website.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">No Professional Advice</h2>
                    <p>
                        The information and tools provided on this website are not intended to constitute professional advice. Any reliance you place on such information is strictly at your own risk. Before making any decisions based on the calculator results, we recommend consulting with qualified professionals in the relevant field.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Limitation of Liability</h2>
                    <p>
                        In no event shall the website, its creators, or its administrators be liable for any indirect, incidental, special, consequential, or punitive damages, or any other damages whatsoever arising from or relating to your use of the calculator or the information provided, including but not limited to damages for loss of profits, data, or other intangible losses.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Accuracy of Calculations</h2>
                    <p>
                        While we strive to ensure that the struct padding calculations are accurate, we do not guarantee the complete accuracy of results. Struct memory layout can vary based on compiler, architecture, and optimization settings. Always verify results with your target compiler and system.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Third-Party Content</h2>
                    <p>
                        This website may contain links to third-party websites and resources. We are not responsible for the content, accuracy, or practices of these external sites. Your use of third-party websites is subject to their terms and conditions and privacy policies.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Use at Your Own Risk</h2>
                    <p>
                        You assume all responsibility for your use of this calculator and the results obtained. We strongly recommend testing the calculator output with actual compiler code to verify results before relying on them in production systems.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">No Warranty</h2>
                    <p>
                        The website and its contents are provided without warranty of any kind, either express or implied. We do not warrant that the calculator will meet your specific requirements or that it will be error-free or uninterrupted.
                    </p>
                </section>
            </div>
        </div>
    );
}
