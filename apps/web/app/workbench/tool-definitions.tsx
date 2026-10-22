"use client";

import { createContext, use, useContext } from "react";
import type { ComponentType, ReactNode } from "react";
import { getManifest } from "@sp/registry";
import type { AnyToolDefinition, ToolFamily, ToolResult, ToolSpecBase } from "@sp/engine";

/**
 * The workbench's tools, split by language.
 *
 * Each language has a family module (family-<lang>.tsx) with its tools' definitions and their
 * result views. A tool page's route imports its own language's module up front (shell-<lang>.tsx),
 * so its tool renders in the first render and the static HTML holds the whole workbench. The other
 * languages stay in their own chunks: loaded when one of their tools is opened, and prefetched
 * once the page is idle.
 */
export interface ResultViewProps {
  result: ToolResult;
  spec: ToolSpecBase;
  input: string;
}

export interface ToolFamilyModule {
  definition(id: string): AnyToolDefinition;
  /** Tools whose result needs a bespoke view; the rest use the generic ResultPanel. */
  resultViews: Partial<Record<string, ComponentType<ResultViewProps>>>;
}

type Language = Exclude<ToolFamily, "reference">;

/** The language whose package defines a tool (the reference tools live in the C/C++ package). */
export function definitionFamily(id: string): Language {
  const family = getManifest(id)?.family ?? "layout";
  return family === "reference" ? "layout" : family;
}

const Preloaded = createContext<{ language: Language; module: ToolFamilyModule } | null>(null);

export function ToolFamilyProvider({ language, module, children }: { language: Language; module: ToolFamilyModule; children: ReactNode }) {
  return <Preloaded value={{ language, module }}>{children}</Preloaded>;
}

/** One literal import() per language, so the bundler gives each its own chunk. */
function importFamily(language: Language): Promise<ToolFamilyModule> {
  switch (language) {
    case "layout":
      return import("./family-layout").then((m) => m.family);
    case "go":
      return import("./family-go").then((m) => m.family);
    case "rust":
      return import("./family-rust").then((m) => m.family);
  }
}

/** A promise that React's `use()` reads synchronously once it has settled. */
type Tracked<T> = Promise<T> & { status?: "pending" | "fulfilled" | "rejected"; value?: T; reason?: unknown };
const loading = new Map<Language, Tracked<ToolFamilyModule>>();

function loadFamily(language: Language): Promise<ToolFamilyModule> {
  let p = loading.get(language);
  if (!p) {
    const promise = importFamily(language) as Tracked<ToolFamilyModule>;
    promise.status = "pending";
    promise.then(
      (m) => {
        promise.status = "fulfilled";
        promise.value = m;
      },
      (err: unknown) => {
        promise.status = "rejected";
        promise.reason = err;
        // A later attempt (say after a network blip) starts a fresh download.
        loading.delete(language);
      },
    );
    loading.set(language, promise);
    p = promise;
  }
  return p;
}

/**
 * The definition and result view for `id`: from the page's own language at once, otherwise from
 * its language's chunk. That suspends while it downloads; the shell opens tools in a transition,
 * so React keeps the current tool on screen meanwhile rather than showing anything else.
 */
export function useTool(id: string): { definition: AnyToolDefinition; ResultView?: ComponentType<ResultViewProps> } {
  const preloaded = useContext(Preloaded);
  const language = definitionFamily(id);
  const tools = preloaded?.language === language ? preloaded.module : use(loadFamily(language));
  return { definition: tools.definition(id), ResultView: tools.resultViews[id] };
}

/** Download the other languages' chunks, so switching to one later is immediate. */
export function prefetchToolFamilies(preloaded: Language): void {
  for (const language of ["layout", "go", "rust"] as const) {
    if (language === preloaded) continue;
    loadFamily(language).catch(() => {
      // Retried, with its error shown, if one of that language's tools is opened.
    });
  }
}
