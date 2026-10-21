"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnyToolDefinition, ToolManifest, ToolSpecBase } from "@sp/engine";
import type { OptionValue, OptionValues } from "@sp/contracts";
import { platform } from "@sp/platform";
import { Button, Panel } from "@sp/ui";
import { encodeShareState } from "../share-link";
import { CUSTOM_RESULTS } from "./custom-results";
import { DiagnosticsPanel } from "./diagnostics-panel";
import { FieldTable } from "./field-table";
import { InputPanel } from "./input-panel";
import { OptionsForm } from "./options-form";
import { ResultPanel } from "./result-panel";
import { cachedTool, loadToolCached } from "./tool-cache";
import { useCompute } from "./use-compute";
import { VariantsPanel } from "./variants-panel";

const specKey = (toolId: string) => `spec:${toolId}`;

interface ToolWorkbenchProps {
  manifest: ToolManifest;
  input: string;
  onInputChange: (value: string) => void;
  /** Options from a share link, applied once on top of the saved spec. */
  sharedOptions?: OptionValues;
  onOpenSidebar: () => void;
}

/** Restore a spec: saved options for this tool, then share-link options on top. */
function restoreSpec(t: AnyToolDefinition, sharedOptions: OptionValues | undefined): ToolSpecBase {
  const saved = platform().readSavedState<OptionValues>(specKey(t.id)) ?? {};
  const restored = t.createSpec({ ...saved, ...sharedOptions });
  return t.specSchema.safeParse(restored).success ? restored : t.createSpec();
}

export function ToolWorkbench({
  manifest,
  input,
  onInputChange,
  sharedOptions,
  onOpenSidebar,
}: ToolWorkbenchProps) {
  // The shell keys this component by tool id, so state starts fresh for every tool. When the
  // definition is already cached (always, after the first visit) it initialises in the same
  // render -- no empty frame, no layout jump.
  const [tool, setTool] = useState<AnyToolDefinition | undefined>(() => cachedTool(manifest.id));
  const [spec, setSpec] = useState<ToolSpecBase | undefined>(() => {
    const t = cachedTool(manifest.id);
    return t ? restoreSpec(t, sharedOptions) : undefined;
  });
  const [loadError, setLoadError] = useState<string>();
  const [shareNote, setShareNote] = useState<string>();

  // First visit only: the definition is not cached yet, so load it.
  useEffect(() => {
    if (tool) return;
    let cancelled = false;
    loadToolCached(manifest.id)
      .then((t) => {
        if (cancelled) return;
        setTool(t);
        setSpec(restoreSpec(t, sharedOptions));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [tool, manifest.id, sharedOptions]);

  useEffect(() => {
    if (tool && spec) platform().writeSavedState(specKey(tool.id), spec.options);
  }, [tool, spec]);

  const compute = useCompute(tool, spec, input);

  const setOption = useCallback(
    (id: string, value: OptionValue) => {
      if (!tool) return;
      setSpec((s) =>
        s ? (tool.onOptionChange?.(s, id, value) ?? { ...s, options: { ...s.options, [id]: value } }) : s,
      );
    },
    [tool],
  );

  const applyOptions = useCallback(
    (patch: OptionValues) => {
      if (!tool) return;
      setSpec((s) => (s ? tool.createSpec({ ...s.options, ...patch }) : s));
    },
    [tool],
  );

  const applyFix = useCallback(
    (apply: (s: ToolSpecBase) => ToolSpecBase) => {
      if (!tool) return;
      // Re-normalise through createSpec so fixes can't leave an invalid combination.
      setSpec((s) => (s ? tool.createSpec(apply(s).options) : s));
    },
    [tool],
  );

  const highlighted = useMemo(
    () => new Set(compute.diagnostics.flatMap((d) => d.optionIds ?? [])),
    [compute.diagnostics],
  );

  const copyShareLink = async () => {
    if (!tool || !spec) return;
    const { hash, inputOmitted } = encodeShareState({
      toolId: tool.id,
      options: spec.options,
      input: tool.readsInput ? input : undefined,
    });
    const url = `${window.location.origin}${window.location.pathname}${hash}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareNote(inputOmitted ? "Link copied (input too long to include)" : "Link copied");
    } catch {
      setShareNote("Could not access the clipboard");
    }
    setTimeout(() => setShareNote(undefined), 2500);
  };

  const Custom = CUSTOM_RESULTS[manifest.id];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenSidebar}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 lg:hidden dark:border-gray-600 dark:text-gray-300"
              aria-label="Open tool list"
            >
              ☰ Tools
            </button>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{manifest.label}</h1>
          </div>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {tool && spec ? tool.describe(spec) : manifest.summary}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {shareNote && (
            <span role="status" className="text-xs text-gray-500">
              {shareNote}
            </span>
          )}
          <Button onClick={copyShareLink} disabled={!spec}>
            Copy share link
          </Button>
        </div>
      </header>

      {loadError && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          Failed to load tool: {loadError}
        </p>
      )}

      {!loadError && !(tool && spec) && (
        // First visit only: hold the space the workbench will take, so nothing jumps when it loads.
        <div aria-busy="true" className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="h-96 animate-pulse rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800" />
          <div className="h-96 animate-pulse rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800" />
        </div>
      )}

      {tool && spec && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-4">
            {tool.readsInput && (
              <InputPanel
                value={input}
                onChange={onInputChange}
                samples={tool.samples}
                pending={compute.status === "pending"}
                language={manifest.inputLanguage ?? "c"}
              />
            )}

            <DiagnosticsPanel diagnostics={compute.diagnostics} onFix={applyFix} />

            {compute.result &&
              (Custom ? (
                <Custom result={compute.result} spec={spec} input={input} />
              ) : compute.result.error ? null : (
                <ResultPanel result={compute.result} />
              ))}

            {tool.variants && compute.result?.data !== undefined && !compute.result.error && (
              <VariantsPanel tool={tool} spec={spec} input={input} onSelect={applyOptions} />
            )}
          </div>

          <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
            <OptionsForm
              tool={tool}
              spec={spec}
              tags={compute.tags}
              highlighted={highlighted}
              onChange={setOption}
            />
            {tool.info && (
              <Panel title="Platform facts" collapsible defaultCollapsed>
                <FieldTable fields={tool.info(spec)} />
              </Panel>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
