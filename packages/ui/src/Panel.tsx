"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export interface PanelProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  className?: string;
  bodyClassName?: string;
}

/** Card section used for every workbench block. */
export function Panel({
  title,
  subtitle,
  actions,
  children,
  collapsible = false,
  defaultCollapsed = false,
  className,
  bodyClassName,
}: PanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const bodyId = useId();

  return (
    <section
      className={cn(
        "rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800",
        className,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="min-w-0">
          {collapsible ? (
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              aria-controls={bodyId}
              className="flex items-center gap-2 text-left"
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn("h-4 w-4 text-gray-400 transition-transform", !collapsed && "rotate-90")}
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
            </button>
          ) : (
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          )}
          {subtitle && (
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {!collapsed && (
        <div id={bodyId} className={cn("p-4", bodyClassName)}>
          {children}
        </div>
      )}
    </section>
  );
}
