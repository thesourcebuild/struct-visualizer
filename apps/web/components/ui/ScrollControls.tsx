"use client";

import React, { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { SCROLL_THRESHOLD } from '@/lib/constants';

export default function ScrollControls({ threshold }: { threshold?: number }) {
  // The workbench has sticky side columns; floating buttons there sit on top of the settings.
  const onWorkbench = usePathname().startsWith("/tools");
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(false);

  // use provided threshold, fall back to constant
  const t = typeof threshold === 'number' ? threshold : SCROLL_THRESHOLD;

  useEffect(() => {
    function check() {
      const y = window.scrollY || window.pageYOffset;
      const h = window.innerHeight || document.documentElement.clientHeight;
      const docH = document.documentElement.scrollHeight;
      setAtTop(y < t);
      setAtBottom(y + h >= docH - t);
    }

    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [t]);

  const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });
  const scrollToBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });

  if (onWorkbench) return null;

  return (
    <div className="fixed right-4 bottom-20 flex flex-col gap-2 z-50">
      {!atTop && (
        <button
          onClick={scrollToTop}
          aria-label="Scroll to top"
          title="Scroll to top"
          className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-100 shadow-sm hover:shadow-md transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}

      {!atBottom && (
        <button
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
          className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-100 shadow-sm hover:shadow-md transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}
    </div>
  );
}
