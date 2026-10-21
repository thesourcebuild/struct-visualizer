import { SITE_TITLE } from '@/lib/constants';
import { pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata({
    path: '/cookie-policy/',
    title: 'Cookie Policy',
    description: 'The cookies and browser storage Struct Visualizer uses, and how to control them.',
});

export default function CookiePolicy() {
    return (
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-8">Cookie Policy</h1>

            <div className="space-y-8 text-gray-700 dark:text-gray-300">
                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">1. What Are Cookies?</h2>
                    <p>
                        Cookies are small files placed on your device when you visit a website. They help websites remember information about your visit, such as your preferences, login status, and browsing behavior. Cookies are essential for many websites to function properly.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">2. Cookies We Use</h2>
                    <p>The {SITE_TITLE} uses the following types of cookies:</p>
                    <ul className="list-disc list-inside mt-4 space-y-2">
                        <li><strong>Essential Cookies:</strong> Required for the website to function properly (e.g., theme preference storage)</li>
                        <li><strong>Preference Cookies:</strong> Remember your settings and preferences (e.g., dark mode selection)</li>
                        <li><strong>Analytics Cookies:</strong> Help us understand how users interact with our website</li>
                    </ul>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">3. Third-Party Cookies</h2>
                    <p>
                        We may use third-party services that place cookies on your device for analytics and performance monitoring. These services operate according to their own privacy policies and cookie policies. We recommend reviewing those policies directly.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">4. Controlling Cookies</h2>
                    <p>You have the right to control which cookies you allow:</p>
                    <ul className="list-disc list-inside mt-4 space-y-2">
                        <li><strong>Browser Settings:</strong> Most browsers allow you to refuse cookies or alert you when a cookie is being set</li>
                        <li><strong>Disable Cookies:</strong> You can disable cookies entirely, though this may affect website functionality</li>
                        <li><strong>Clear Cookies:</strong> You can clear cookies from your browser at any time</li>
                    </ul>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">5. Local Storage and Similar Technologies</h2>
                    <p>
                        In addition to cookies, we may use local storage and similar technologies to store information on your device. This includes storing your theme preference and calculator settings. You can clear this data through your browser settings.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">6. Consent</h2>
                    <p>
                        By continuing to use this website, you consent to our use of cookies and similar technologies as described in this policy. If you do not consent, please adjust your browser settings or refrain from using our website.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">7. Changes to This Policy</h2>
                    <p>
                        We may update this Cookie Policy from time to time to reflect changes in our practices or technology. We encourage you to review this policy periodically to stay informed about how we use cookies.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">8. Cookie List</h2>
                    <p>Common cookies used on our website:</p>
                    <ul className="list-disc list-inside mt-4 space-y-2">
                        <li><strong>theme:</strong> Stores your theme preference (light/dark/system)</li>
                        <li><strong>_ga:</strong> Google Analytics tracking (if enabled)</li>
                    </ul>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">9. Contact Us</h2>
                    <p>
                        If you have questions about our use of cookies or this Cookie Policy, please contact us through the information provided on our website.
                    </p>
                </section>
            </div>
        </div>
    );
}
