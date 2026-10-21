"use client";

import React from 'react';

type CookieConsentGlobal = typeof globalThis & {
    showCookieConsent?: () => void;
};

export default function CookieSettingsButton({ className }: { className?: string }) {
    const openConsent = () => {
        (globalThis as CookieConsentGlobal).showCookieConsent?.();
    };

    return (
        <button
            type="button"
            onClick={openConsent}
            className={className ?? 'text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors'}
        >
            Cookie settings
        </button>
    );
}
