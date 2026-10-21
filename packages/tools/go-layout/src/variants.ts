import { GO_TARGETS, analyzeGo } from "@sp/core";
import type { ToolVariantRow, ToolVariantTable } from "@sp/engine";
import { readGoTarget } from "./create-spec";
import { OPTION_GO_TARGET, readMode } from "./pure";
import type { GoLayoutSpec } from "./spec";

/** The same struct on every Go target. */
export function goLayoutVariants(spec: GoLayoutSpec, input: string): ToolVariantTable {
  const current = readGoTarget(spec.options);
  const mode = readMode(spec.options);

  const rows: ToolVariantRow[] = GO_TARGETS.map((target) => {
    const a = analyzeGo(input, target.id);
    const r = mode === "optimized" ? a.optimized : a.result;
    return {
      cells: {
        compiler: target.compiler === "gc" ? "gc" : "TinyGo",
        target: target.label,
        word: `${target.wordSize * 8}-bit`,
        size: r ? r.totalSize : "—",
        alignment: r ? (r.struct.alignment ?? 1) : "—",
        padding: r ? r.totalPadding : "—",
      },
      options: { [OPTION_GO_TARGET]: target.id },
      current: target.id === current,
      error: a.errors[0]?.message,
    };
  });

  return {
    title: "Across targets",
    summary: `The same struct on every target (${mode === "optimized" ? "optimized" : "declared"} field order). Click a row to switch to it.`,
    columns: [
      { key: "compiler", label: "Compiler" },
      { key: "target", label: "Target" },
      { key: "word", label: "Word" },
      { key: "size", label: "Size", align: "right", mono: true },
      { key: "alignment", label: "Align", align: "right", mono: true },
      { key: "padding", label: "Padding", align: "right", mono: true },
    ],
    rows,
    groupBy: "compiler",
    compareKey: "size",
  };
}
