"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_TOOL_ID, equivalentTool, getManifest, isLanguageFamily } from "@sp/registry";
import type { OptionValues } from "@sp/contracts";
import type { InputLanguage, ToolFamily } from "@sp/engine";
import { platform } from "@sp/platform";
import { BASE_PATH } from "@/lib/constants";
import { parseShareHash } from "../share-link";
import { DEFAULT_INPUTS } from "./default-input";
import { preloadAllTools } from "./tool-cache";
import { openGuide } from "@/components/guides/guide-overlay";
import { Sidebar } from "./sidebar";
import { ToolWorkbench } from "./tool-workbench";

const KEY_LAST_TOOL = "lastTool";
/** Saved input per language; C keeps the original key so earlier saved state still loads. */
const inputKey = (language: InputLanguage) => (language === "c" ? "input" : `input:${language}`);
const LANGUAGES = Object.keys(DEFAULT_INPUTS) as InputLanguage[];
const languageOf = (toolId: string): InputLanguage => getManifest(toolId)?.inputLanguage ?? "c";
/** The tool's family when it is a source language (not a reference tool). */
const familyLanguage = (toolId: string): ToolFamily | undefined => {
  const family = getManifest(toolId)?.family;
  return family && isLanguageFamily(family) ? family : undefined;
};
const KEY_COLLAPSED = "sidebar:collapsedFamilies";
const KEY_LANGUAGE = "sidebar:language";

function toolIdFromPath(pathname: string): string | undefined {
  const rest = pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) : pathname;
  const id = /^\/tools\/([^/]+)\/?$/.exec(rest)?.[1];
  return id && getManifest(id) ? id : undefined;
}

interface AppShellProps {
  /** Tool chosen by the route (/tools/<id>/). Undefined on /tools/, which restores the last tool. */
  initialToolId?: string;
}

/**
 * The workbench: sidebar + one tool. Owns the tool selection, persistence and the inputs: one
 * per language, shared by that language's tools, so a Go tool never receives C source.
 */
export function AppShell({ initialToolId }: AppShellProps) {
  const [selectedId, setSelectedId] = useState(initialToolId ?? DEFAULT_TOOL_ID);
  const [inputs, setInputs] = useState<Record<InputLanguage, string>>(DEFAULT_INPUTS);
  const [sharedOptions, setSharedOptions] = useState<OptionValues>();
  const [collapsedFamilies, setCollapsedFamilies] = useState<string[]>([]);
  /** Sidebar language; follows the open tool, and is kept while a reference tool is open. */
  const [language, setLanguage] = useState<ToolFamily>(() => familyLanguage(initialToolId ?? DEFAULT_TOOL_ID) ?? "layout");

  /** Show a tool; the sidebar language follows it when it belongs to a language. */
  const openTool = useCallback((id: string) => {
    setSelectedId(id);
    const family = familyLanguage(id);
    if (family) setLanguage(family);
  }, []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Restore after mount (static HTML can't know localStorage or the URL fragment).
  useEffect(() => {
    const p = platform();
    const shared = parseShareHash(window.location.hash);
    const saved = { ...DEFAULT_INPUTS };
    for (const language of LANGUAGES) {
      const value = p.readSavedState<string>(inputKey(language));
      if (value) saved[language] = value;
    }
    const savedTool = p.readSavedState<string>(KEY_LAST_TOOL);
    // One-time restore from external state (localStorage, URL fragment). It cannot run during
    // render: the page is statically exported, so the server render must match the first client render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsedFamilies(p.readSavedState<string[]>(KEY_COLLAPSED) ?? []);
    const savedLanguage = p.readSavedState<ToolFamily>(KEY_LANGUAGE);
    if (savedLanguage && isLanguageFamily(savedLanguage)) setLanguage(savedLanguage);

    if (shared && getManifest(shared.toolId)) {
      openTool(shared.toolId);
      setSharedOptions(shared.options);
      setInputs(shared.input !== undefined ? { ...saved, [languageOf(shared.toolId)]: shared.input } : saved);
      // Drop the fragment so a reload uses saved state, not the stale link.
      window.history.replaceState(null, "", `${BASE_PATH}/tools/${shared.toolId}/`);
    } else {
      setInputs(saved);
      if (!initialToolId && savedTool && getManifest(savedTool)) openTool(savedTool);
      else if (initialToolId) openTool(initialToolId);
    }
    setHydrated(true);
    // Warm every tool definition so later sidebar clicks render in one frame.
    preloadAllTools();
  }, [initialToolId, openTool]);

  useEffect(() => {
    if (!hydrated) return;
    for (const language of LANGUAGES) platform().writeSavedState(inputKey(language), inputs[language]);
  }, [inputs, hydrated]);

  useEffect(() => {
    if (hydrated) platform().writeSavedState(KEY_LAST_TOOL, selectedId);
  }, [selectedId, hydrated]);

  // Back/forward between tools.
  useEffect(() => {
    const onPop = () => {
      const id = toolIdFromPath(window.location.pathname);
      if (id) openTool(id);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [openTool]);

  const selectTool = useCallback(
    (id: string) => {
      setDrawerOpen(false);
      if (id === selectedId) return;
      setSharedOptions(undefined);
      openTool(id);
      window.history.pushState(null, "", `${BASE_PATH}/tools/${id}/`);
      window.scrollTo({ top: 0 });
    },
    [selectedId, openTool],
  );

  const toggleFamily = useCallback((family: string) => {
    setCollapsedFamilies((prev) => {
      const next = prev.includes(family) ? prev.filter((f) => f !== family) : [...prev, family];
      platform().writeSavedState(KEY_COLLAPSED, next);
      return next;
    });
  }, []);

  const manifest = getManifest(selectedId) ?? getManifest(DEFAULT_TOOL_ID)!;
  const sidebarLanguage = isLanguageFamily(manifest.family) ? manifest.family : language;

  useEffect(() => {
    if (hydrated) platform().writeSavedState(KEY_LANGUAGE, sidebarLanguage);
  }, [sidebarLanguage, hydrated]);

  const selectLanguage = useCallback(
    (family: ToolFamily) => {
      setLanguage(family);
      // A language tool switches to its counterpart; a reference tool stays open.
      if (isLanguageFamily(manifest.family)) {
        const next = equivalentTool(manifest.id, family);
        if (next) selectTool(next);
      }
    },
    [manifest, selectTool],
  );
  const inputLanguage = manifest.inputLanguage ?? "c";
  const setInput = useCallback(
    (value: string) => setInputs((prev) => ({ ...prev, [inputLanguage]: value })),
    [inputLanguage],
  );

  const sidebar = (
    <Sidebar
      selectedId={manifest.id}
      onSelect={selectTool}
      language={sidebarLanguage}
      onSelectLanguage={selectLanguage}
      collapsedFamilies={collapsedFamilies}
      onToggleFamily={toggleFamily}
      onOpenGuide={(id) => {
        setDrawerOpen(false);
        openGuide(id);
      }}
    />
  );

  return (
    <div className="flex w-full gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <aside className="hidden w-64 shrink-0 lg:block">
        <div className="sticky top-20">{sidebar}</div>
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Tools">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close tool list"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-80 max-w-[85vw] overflow-y-auto bg-gray-50 p-3 shadow-xl dark:bg-gray-900">
            {sidebar}
          </div>
        </div>
      )}

      <div className="min-w-0 flex-1">
        {hydrated ? (
          <ToolWorkbench
            key={manifest.id}
            manifest={manifest}
            input={inputs[inputLanguage]}
            onInputChange={setInput}
            sharedOptions={sharedOptions}
            onOpenSidebar={() => setDrawerOpen(true)}
          />
        ) : (
          <div className="space-y-2">
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{manifest.label}</h1>
            <p className="text-sm text-gray-600 dark:text-gray-400">{manifest.summary}</p>
          </div>
        )}
      </div>
    </div>
  );
}
