"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CalculationResult } from "@sp/core";
import { Button, CopyButton, Panel } from "@sp/ui";
import CodeEditor from "@/components/tools/editor/CodeEditor";
import StructVisualizer from "@/components/ui/tools/visualizer/StructVisualizer";
import type { TabOption } from "@/components/ui/tools/visualizer/StructVisualizer";
import { exportResultAsJsonFile, exportResultAsPngFile } from "../export/layout-export";
import type { JsonExportInput } from "../export/layout-export";
import { PaddingProcess } from "./padding-process";

type SectionHeights = Partial<Record<"visualization" | "statistics" | "details", number>>;

export interface LayoutBadge {
  label: string;
  value: string;
}

export interface LayoutViewProps {
  /** The layout selected by the mode. */
  display: CalculationResult | null;
  /** The definition as written; null when it could not be laid out. */
  original: CalculationResult | null;
  optimized: CalculationResult | null;
  /** 'natural', 'packed' or 'optimized'; anything but natural is shown as a tag. */
  mode: string;
  /** Show the original and optimized layouts side by side. */
  compare: boolean;
  explain: boolean;
  /** Record kind for the title, e.g. "struct", "union", "type". */
  kind: string;
  badges: readonly LayoutBadge[];
  /** Reordered source, shown in optimized mode. */
  optimizedCode: string | null;
  optimizedSubtitle: string;
  /** Shown when there is nothing to lay out. */
  emptyHint: string;
  /** Export metadata; the result itself is added here. */
  exportInfo: Omit<JsonExportInput, "displayResult">;
  /** The platform line on the PNG export. */
  exportSubtitle: string;
  /** Extra panels after the layout (e.g. language-specific notes). */
  children?: ReactNode;
}

function Badge({ label, value }: LayoutBadge) {
  return (
    <span className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
      <strong className="text-gray-700 dark:text-gray-200">{label}:</strong> {value}
    </span>
  );
}

/** Keep the optimized card's sections as tall as the original's, so rows line up. */
function useMatchedHeights(enabled: boolean, deps: unknown[]) {
  const originalRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState<number | null>(null);
  const [sections, setSections] = useState<SectionHeights>({});

  useEffect(() => {
    const el = originalRef.current;
    if (!enabled || !el) {
      setCardHeight(null);
      setSections({});
      return;
    }
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setCardHeight(Math.ceil(h));
      const next: SectionHeights = {};
      for (const key of ["visualization", "statistics", "details"] as const) {
        const s = el.querySelector<HTMLElement>(`[data-section="${key}"]`);
        if (s) next[key] = Math.ceil(s.getBoundingClientRect().height);
      }
      setSections(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  return { originalRef, cardHeight, sections };
}

/** Language-neutral layout result: byte map, comparison, export, step-by-step. */
export function LayoutView(props: LayoutViewProps) {
  const { display, original, optimized, mode, explain, kind, badges, optimizedCode } = props;
  const [view, setView] = useState<TabOption>("all");
  const comparing = mode === "optimized" && props.compare && !!original && !!optimized;
  const { originalRef, cardHeight, sections } = useMatchedHeights(comparing, [view, display]);

  if (!display || !original) {
    return (
      <Panel title="Memory layout">
        <div className="py-10 text-center">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Nothing to visualize</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{props.emptyHint}</p>
        </div>
      </Panel>
    );
  }

  const exportJson = () => exportResultAsJsonFile({ ...props.exportInfo, displayResult: display });
  const exportPng = () => exportResultAsPngFile({ displayResult: display, subtitle: props.exportSubtitle });

  return (
    <div className="space-y-4">
      <Panel
        title={
          <span className="flex flex-wrap items-center gap-2">
            {kind} <code className="font-mono">{display.struct.name}</code>
            <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
              {display.totalSize} bytes
            </span>
            {mode !== "natural" && (
              <span className="rounded bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-800 dark:bg-purple-900/40 dark:text-purple-200">
                {mode}
              </span>
            )}
          </span>
        }
        actions={
          <>
            <select
              aria-label="Sections to show"
              value={view}
              onChange={(e) => setView(e.target.value as TabOption)}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
            >
              <option value="all">All sections</option>
              <option value="visualization">Memory visualization</option>
              <option value="statistics">Statistics</option>
              <option value="details">Member details</option>
            </select>
            <Button onClick={exportJson}>Export JSON</Button>
            <Button onClick={exportPng}>Export PNG</Button>
          </>
        }
      >
        <div className="mb-4 flex flex-wrap gap-2">
          {badges.map((b) => (
            <Badge key={b.label} {...b} />
          ))}
          {original.totalSize !== display.totalSize && <Badge label="Original" value={`${original.totalSize} bytes`} />}
        </div>

        {comparing ? (
          <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-2">
            <div ref={originalRef} className="flex flex-col">
              <h3 className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">Original</h3>
              <StructVisualizer result={original} hideDropdown activeTab={view} onTabChange={setView} />
            </div>
            <div className="flex flex-col" style={cardHeight ? { minHeight: cardHeight } : undefined}>
              <h3 className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">Optimized</h3>
              <StructVisualizer
                result={optimized!}
                hideDropdown
                activeTab={view}
                onTabChange={setView}
                sectionMinHeights={sections}
              />
            </div>
          </div>
        ) : (
          <StructVisualizer result={display} hideDropdown activeTab={view} onTabChange={setView} />
        )}
      </Panel>

      {mode === "optimized" && optimizedCode && (
        <Panel
          title="Optimized definition"
          subtitle={props.optimizedSubtitle}
          actions={<CopyButton value={optimizedCode} />}
          bodyClassName="p-3"
        >
          <div className="h-60">
            <CodeEditor value={optimizedCode} onChange={() => {}} readOnly />
          </div>
        </Panel>
      )}

      {props.children}

      {!comparing && <PaddingProcess result={display} explain={explain} />}
    </div>
  );
}
