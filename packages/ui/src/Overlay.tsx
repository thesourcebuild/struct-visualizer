"use client";

import { useEffect, useId, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Extra header controls (e.g. "Open as page"), shown before the close button. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * A right-hand sheet for reading content without leaving the current page (guides, help).
 *
 * Built on the native <dialog> in modal mode, so focus is trapped, the rest of the page is inert
 * and Escape closes it -- none of that is reimplemented here. Clicking the dimmed backdrop also
 * closes it, and page scrolling is locked while it is open so only the sheet scrolls.
 */
export function Overlay({ open, onClose, title, subtitle, actions, children }: OverlayProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Layout effect, not effect: the dialog opens before the browser paints, so the sheet, its
  // content and the blurred backdrop all appear in the same frame. With useEffect the page
  // painted once without them, and the sheet visibly arrived late.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        // Clicks on the ::backdrop are delivered to the dialog element itself.
        if (e.target === ref.current) onClose();
      }}
      className="sp-sheet m-0 ml-auto h-dvh max-h-none w-full max-w-3xl overflow-hidden border-l border-gray-200 bg-gray-50 p-0 text-gray-900 shadow-2xl backdrop:bg-gray-950/40 backdrop:backdrop-blur-[2px] dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-gray-200 bg-white px-6 py-4 dark:border-gray-800 dark:bg-gray-900">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
              title="Close (Esc)"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4.5 w-4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
              <span className="sr-only">Close</span>
            </button>
          </div>
        </header>
        {/* autoFocus: the dialog focuses this on open instead of the first header control, so no
            focus ring appears on "Open as page" and arrow keys scroll the content straight away. */}
        <div
          tabIndex={-1}
          autoFocus
          className="flex-1 overflow-y-auto overscroll-contain px-6 py-6 outline-none"
        >
          {children}
        </div>
      </div>
    </dialog>
  );
}
