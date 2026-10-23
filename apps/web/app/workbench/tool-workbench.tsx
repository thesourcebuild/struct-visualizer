"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnyToolDefinition, ToolManifest, ToolSample, ToolSpecBase } from "@sp/engine";
import type { OptionValue, OptionValues } from "@sp/contracts";
import { platform } from "@sp/platform";
import { Button, Panel } from "@sp/ui";
import { encodeShareState } from "../share-link";
import { DiagnosticsPanel } from "./diagnostics-panel";
import { FieldTable } from "./field-table";
import { InputPanel } from "./input-panel";
import { OptionsForm } from "./options-form";
import { ResultPanel } from "./result-panel";
import { useTool } from "./tool-definitions";
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
  // The shell keys this component by tool id, so state starts fresh for every tool. The page's own
  // language is there synchronously, so the static HTML holds the whole workbench and the first
  // render in the browser is that same markup: nothing is swapped in, nothing moves.
  const { definition: tool, ResultView: Custom } = useTool(manifest.id);
  // The first render must match that HTML, so it uses the defaults; saved and shared options can
  // only be read after mount (localStorage, the URL fragment) and are applied then.
  const [spec, setSpec] = useState<ToolSpecBase>(() => tool.createSpec());
  const [restored, setRestored] = useState(false);
  const [shareNote, setShareNote] = useState<string>();

  useEffect(() => {
    // One-time restore from browser state, which the static HTML cannot know.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSpec(restoreSpec(tool, sharedOptions));
    setRestored(true);
  }, [tool, sharedOptions]);

  // Not before the restore: the defaults of the first render would overwrite the saved options.
  useEffect(() => {
    if (restored) platform().writeSavedState(specKey(tool.id), spec.options);
  }, [tool, spec, restored]);

  const compute = useCompute(tool, spec, input);

  const setOption = useCallback(
    (id: string, value: OptionValue) => {
      setSpec((s) => tool.onOptionChange?.(s, id, value) ?? { ...s, options: { ...s.options, [id]: value } });
    },
    [tool],
  );

  const applyOptions = useCallback(
    (patch: OptionValues) => {
      setSpec((s) => tool.createSpec({ ...s.options, ...patch }));
    },
    [tool],
  );

  const loadSample = useCallback(
    (sample: ToolSample) => {
      onInputChange(sample.input);
      if (sample.options) applyOptions(sample.options);
    },
    [onInputChange, applyOptions],
  );

  const applyFix = useCallback(
    (apply: (s: ToolSpecBase) => ToolSpecBase) => {
      // Re-normalise through createSpec so fixes can't leave an invalid combination.
      setSpec((s) => tool.createSpec(apply(s).options));
    },
    [tool],
  );

  const highlighted = useMemo(
    () => new Set(compute.diagnostics.flatMap((d) => d.optionIds ?? [])),
    [compute.diagnostics],
  );

  const copyShareLink = async () => {
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
            {tool.describe(spec)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {shareNote && (
            <span role="status" className="text-xs text-gray-500">
              {shareNote}
            </span>
          )}
          <Button onClick={copyShareLink}>
            Copy share link
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {tool.readsInput && (
            <InputPanel
              value={input}
              onChange={onInputChange}
              onSample={loadSample}
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
    </div>
  );
}
