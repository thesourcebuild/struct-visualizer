"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FAMILY_LABEL,
  TOOL_MANIFESTS,
  isLanguageFamily,
  languageFamilies,
  presentFamilies,
} from "@sp/registry";
import type { ToolFamily, ToolManifest } from "@sp/engine";
import { cn } from "@sp/ui";
import type { GuideId } from "@/components/guides/guide-overlay";
import { AlertIcon, BookIcon, ChevronIcon, FAMILY_ACCENT, SearchIcon, ToolIcon } from "./icons";

interface SidebarProps {
  selectedId: string;
  onSelect: (id: string) => void;
  /** The source language whose tools are listed. */
  language: ToolFamily;
  onSelectLanguage: (family: ToolFamily) => void;
  collapsedFamilies: readonly string[];
  onToggleFamily: (family: string) => void;
  /** Opens a guide in an overlay, so reading it does not leave the workbench. */
  onOpenGuide: (id: GuideId) => void;
}

function matches(m: ToolManifest, q: string): boolean {
  if (!q) return true;
  const hay = [m.label, m.summary, m.category, ...m.tags].join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

/**
 * Language selector, then that language's tools and the reference tools. A search lists matches
 * from every language. "/" focuses the search box.
 */
export function Sidebar({
  selectedId,
  onSelect,
  language,
  onSelectLanguage,
  collapsedFamilies,
  onToggleFamily,
  onOpenGuide,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const families = useMemo(
    () =>
      presentFamilies()
        .filter((family) => query !== "" || !isLanguageFamily(family) || family === language)
        .map((family) => ({
          family,
          tools: TOOL_MANIFESTS.filter((m) => m.family === family && matches(m, query)),
        }))
        .filter((f) => f.tools.length > 0),
    [query, language],
  );

  return (
    <nav
      aria-label="Tools"
      className="flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="space-y-2 border-b border-gray-100 p-3 dark:border-gray-700">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Language
          </span>
          <span className="relative block">
            <span
              className={cn(
                "pointer-events-none absolute left-2.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full",
                FAMILY_ACCENT[language].dot,
              )}
            />
            <select
              value={language}
              onChange={(e) => onSelectLanguage(e.target.value as ToolFamily)}
              className="w-full appearance-none rounded-lg border border-gray-200 bg-gray-50 py-2 pl-7 pr-8 text-sm font-medium text-gray-900 focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            >
              {languageFamilies().map((family) => (
                <option key={family} value={family}>
                  {FAMILY_LABEL[family]}
                </option>
              ))}
            </select>
            <ChevronIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-90 text-gray-400" />
          </span>
        </label>
        <label className="relative block">
          <span className="sr-only">Search tools</span>
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Search tools"
            className="w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-8 pr-8 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-gray-200 bg-white px-1.5 font-mono text-[10px] text-gray-400 dark:border-gray-600 dark:bg-gray-800">
            /
          </kbd>
        </label>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-2">
        {families.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-gray-500">
            No tools match &ldquo;{query}&rdquo;.
          </p>
        )}

        {families.map(({ family, tools }) => {
          // The selected language's tools need no heading: the selector above names them.
          const headed = query !== "" || !isLanguageFamily(family);
          const collapsed = headed && collapsedFamilies.includes(family) && !query;
          return (
            <section key={family}>
              {headed && (
                <button
                  type="button"
                  onClick={() => onToggleFamily(family)}
                  aria-expanded={!collapsed}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", FAMILY_ACCENT[family].dot)} />
                  <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {FAMILY_LABEL[family]}
                  </span>
                  <span className="rounded-full bg-gray-100 px-1.5 text-[10px] font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                    {tools.length}
                  </span>
                  <ChevronIcon
                    className={cn(
                      "h-3.5 w-3.5 text-gray-400 transition-transform",
                      !collapsed && "rotate-90",
                    )}
                  />
                </button>
              )}

              {!collapsed && (
                <ul className={cn("space-y-0.5", headed && "mt-1")}>
                  {tools.map((m) => {
                    const here = m.id === selectedId;
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(m.id)}
                          aria-current={here ? "page" : undefined}
                          className={cn(
                            "group flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors",
                            here
                              ? "bg-blue-50 ring-1 ring-blue-200 dark:bg-blue-500/10 dark:ring-blue-500/30"
                              : "hover:bg-gray-50 dark:hover:bg-gray-700/50",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                              here ? "bg-blue-600 text-white" : FAMILY_ACCENT[m.family].tile,
                            )}
                          >
                            <ToolIcon toolId={m.id} className="h-4.5 w-4.5" />
                          </span>
                          <span className="min-w-0">
                            <span
                              className={cn(
                                "block text-sm font-medium",
                                here
                                  ? "text-blue-700 dark:text-blue-300"
                                  : "text-gray-800 dark:text-gray-200",
                              )}
                            >
                              {m.label}
                            </span>
                            {/* No `block` here: line-clamp sets its own display, and `block` would override it. */}
                            <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-gray-500 dark:text-gray-400">
                              {m.summary}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <div className="space-y-1 border-t border-gray-100 p-2 dark:border-gray-700">
        <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Guides
        </p>
        {(
          [
            { id: "padding-rules", label: "Padding rules explained", Icon: BookIcon },
            { id: "limitations", label: "Limitations", Icon: AlertIcon },
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onOpenGuide(id)}
            aria-haspopup="dialog"
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/50"
          >
            <Icon className="h-4 w-4 text-gray-400" />
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}
