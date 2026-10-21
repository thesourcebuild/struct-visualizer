"use client";

import type { Diagnostic, DiagnosticLevel } from "@sp/contracts";
import type { ToolSpecBase } from "@sp/engine";
import { Button, cn } from "@sp/ui";

const LEVEL_STYLE: Record<DiagnosticLevel, { box: string; badge: string; label: string }> = {
  error: {
    box: "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20",
    badge: "bg-severity-error text-white",
    label: "Error",
  },
  warning: {
    box: "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20",
    badge: "bg-severity-warning text-gray-900",
    label: "Warning",
  },
  info: {
    box: "border-sky-200 bg-sky-50 dark:border-sky-800 dark:bg-sky-900/20",
    badge: "bg-severity-info text-white",
    label: "Note",
  },
};

interface DiagnosticsPanelProps {
  diagnostics: readonly Diagnostic<ToolSpecBase>[];
  onFix: (apply: (spec: ToolSpecBase) => ToolSpecBase) => void;
}

/** Lint results, most severe first, each with an optional one-click fix. */
export function DiagnosticsPanel({ diagnostics, onFix }: DiagnosticsPanelProps) {
  if (diagnostics.length === 0) return null;

  return (
    <ul className="space-y-2" aria-label="Diagnostics">
      {diagnostics.map((d, i) => {
        const style = LEVEL_STYLE[d.level];
        return (
          <li
            key={`${d.code}-${i}`}
            className={cn("flex flex-wrap items-start gap-3 rounded-lg border px-3 py-2.5", style.box)}
          >
            <span
              className={cn("mt-0.5 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold", style.badge)}
              title={style.label}
            >
              {d.code}
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-gray-900 dark:text-gray-100">
                <span className="sr-only">{style.label}: </span>
                {d.message}
                {d.line !== undefined && (
                  <span className="ml-2 font-mono text-xs text-gray-500">line {d.line}</span>
                )}
              </p>
              {d.detail && <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">{d.detail}</p>}
            </div>
            {d.fix && (
              <Button variant="secondary" onClick={() => onFix(d.fix!.apply)}>
                {d.fix.label}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
