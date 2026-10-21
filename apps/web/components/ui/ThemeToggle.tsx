"use client";

import React from "react";
import { useTheme } from "@/app/use-theme";

/**
 * Quick light/dark flip as an icon button. The full Light/Dark/System choice lives in Settings.
 * Both icons are rendered and swapped with the `dark:` variant, so the server-rendered HTML is
 * correct before hydration and never flashes the wrong icon.
 */
export default function ThemeToggle({ className }: { className?: string }) {
  const { setPreference } = useTheme();

  const toggleTheme = () => {
    const isDark = document.documentElement.classList.contains("dark");
    setPreference(isDark ? "light" : "dark");
  };

  return (
    <button type="button" onClick={toggleTheme} className={className} title="Toggle light/dark theme">
      {/* Moon in light mode: the action is "go dark". */}
      <svg
        viewBox="0 0 24 24"
        className="h-4.5 w-4.5 dark:hidden"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
      {/* Sun in dark mode: the action is "go light". */}
      <svg
        viewBox="0 0 24 24"
        className="hidden h-4.5 w-4.5 dark:block"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}
