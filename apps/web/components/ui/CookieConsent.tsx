"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type CookieConsentGlobal = typeof globalThis & {
    showCookieConsent?: () => void;
};

const hasStoredConsent = (): boolean => {
    if (typeof window === "undefined") return true;

    try {
        const consent = localStorage.getItem("cookie_consent");
        if (consent) return true;
    } catch (e) {
        console.debug("CookieConsent: localStorage unavailable", e);
    }

    try {
        const match = document.cookie.split("; ").find((c) => c.startsWith("cookie_consent="));
        if (match?.split("=")[1]) return true;
    } catch (e) {
        console.debug("CookieConsent: unable to read cookies", e);
    }

    return false;
};

export default function CookieConsent() {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        // Check consent after mount to avoid hydration mismatch
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setVisible(!hasStoredConsent());

        // expose a global helper so other client components can re-open the dialog
        (globalThis as CookieConsentGlobal).showCookieConsent = () => setVisible(true);
    }, []);

    const persist = (value: "accepted" | "rejected") => {
        try {
            localStorage.setItem("cookie_consent", value);
            // Also set a cookie for server-side awareness if needed
            const expiry = new Date();
            expiry.setDate(expiry.getDate() + 365);
            document.cookie = `cookie_consent=${value}; expires=${expiry.toUTCString()}; path=/`;
        } catch (e) {
            console.warn('CookieConsent: failed to persist consent', e);
        }
        setVisible(false);
    };

    if (!visible) return null;

    return (
        <dialog
            open
            style={{ display: visible ? "block" : "none" }}
            aria-label="Cookie consent"
            className="fixed left-1/2 bottom-6 z-50 transform -translate-x-1/2 bg-transparent border-0 p-0 m-0"
        >
            <div className="max-w-5xl w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-4 flex flex-col sm:flex-row items-start sm:items-center gap-4">
                <div className="flex-1 text-sm text-gray-800 dark:text-gray-200">
                    We use cookies and similar technologies to improve your experience. By clicking &quot;Accept&quot; you agree to our use of cookies.
                </div>

                <div className="flex items-center gap-3">
                    <Link href="/cookie-policy" className="text-sm text-gray-600 dark:text-gray-300 hover:underline">
                        Learn more
                    </Link>
                    <button
                        onClick={() => persist("rejected")}
                        className="px-3 py-2 rounded-md text-sm bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-600"
                    >
                        Decline
                    </button>
                    <button
                        onClick={() => persist("accepted")}
                        className="px-3 py-2 rounded-md text-sm bg-blue-600 hover:bg-blue-700 text-white"
                    >
                        Accept
                    </button>
                </div>
            </div>
        </dialog>
    );
}
