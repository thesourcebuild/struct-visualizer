import { SITE_TITLE } from '@/lib/constants';
import { pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata({
    path: '/privacy-policy/',
    title: 'Privacy Policy',
    description: 'How Struct Visualizer handles your data: your code is processed in your browser and never uploaded.',
});

export default function PrivacyPolicy() {
    return (
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-8">Privacy Policy</h1>

            <div className="space-y-8 text-gray-700 dark:text-gray-300">
                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">1. Introduction</h2>
                    <p>
                        The {SITE_TITLE} (&quot;we,&quot; &quot;us,&quot; &quot;our,&quot; or &quot;website&quot;) is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you visit our website.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">2. Information We Collect</h2>
                    <p>We may collect information about you in a variety of ways:</p>
                    <ul className="list-disc list-inside mt-4 space-y-2">
                        <li><strong>Browser Information:</strong> Information about the browser you use, your IP address, and pages visited</li>
                        <li><strong>Usage Data:</strong> How you interact with the calculator and website features</li>
                        <li><strong>Voluntary Information:</strong> Any information you provide through forms or feedback</li>
                        <li><strong>Struct Code:</strong> The C/C++ struct definitions you enter are processed locally and not stored on our servers</li>
                    </ul>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">3. How We Use Your Information</h2>
                    <p>We use the information we collect to:</p>
                    <ul className="list-disc list-inside mt-4 space-y-2">
                        <li>Provide and improve the calculator and website</li>
                        <li>Understand how users interact with our service</li>
                        <li>Respond to user inquiries and feedback</li>
                        <li>Monitor and analyze website performance</li>
                        <li>Ensure the security and integrity of our website</li>
                    </ul>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">4. Data Storage and Processing</h2>
                    <p>
                        Struct definitions and calculations you enter in the calculator are processed locally in your browser. We do not store your struct code or calculation data on our servers unless you explicitly submit it to us.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">5. Third-Party Services</h2>
                    <p>
                        We may use third-party services for analytics and website improvement. These services may collect information about your use of our website in accordance with their privacy policies. We recommend reviewing the privacy policies of any third-party services.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">6. Cookies and Tracking</h2>
                    <p>
                        Our website may use cookies and similar tracking technologies to enhance your experience. You can control cookie settings through your browser preferences. See our Cookie Policy for more details.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">7. Security</h2>
                    <p>
                        We implement security measures designed to protect your information. However, no method of transmission over the Internet or electronic storage is completely secure. We cannot guarantee absolute security.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">8. Your Privacy Rights</h2>
                    <p>
                        Depending on your location, you may have certain rights regarding your personal data, including the right to access, correct, or delete your information. Contact us if you wish to exercise these rights.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">9. Children&apos;s Privacy</h2>
                    <p>
                        Our website is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. If we become aware that we have collected such information, we will take steps to delete it promptly.
                    </p>
                </section>

                <section>
                    <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">10. Contact Us</h2>
                    <p>
                        If you have questions about this Privacy Policy or our privacy practices, please contact us through the information provided on our website.
                    </p>
                </section>
            </div>
        </div>
    );
}
