import { RUST_TARGETS, analyzeRust } from "@sp/core";
import type { ToolVariantRow, ToolVariantTable } from "@sp/engine";
import { readRustTarget } from "./create-spec";
import { OPTION_RUST_TARGET, readMode } from "./pure";
import type { RustLayoutSpec } from "./spec";

/** The same definition on every Rust target. */
export function rustLayoutVariants(spec: RustLayoutSpec, input: string): ToolVariantTable {
  const current = readRustTarget(spec.options);
  const mode = readMode(spec.options);

  const rows: ToolVariantRow[] = RUST_TARGETS.map((target) => {
    const a = analyzeRust(input, target.id);
    const r = mode === "optimized" ? (a.optimized ?? a.result) : a.result;
    return {
      cells: {
        word: `${target.pointerBytes * 8}-bit`,
        target: target.label,
        size: r ? r.totalSize : "—",
        alignment: r ? (r.struct.alignment ?? 1) : "—",
        padding: r ? r.totalPadding : "—",
        option: a.optionSize ?? "—",
      },
      options: { [OPTION_RUST_TARGET]: target.id },
      current: target.id === current,
      error: a.errors[0]?.message,
    };
  });

  return {
    title: "Across targets",
    summary: "The same definition on every target. Click a row to switch to it.",
    columns: [
      { key: "word", label: "Pointer" },
      { key: "target", label: "Target" },
      { key: "size", label: "Size", align: "right", mono: true },
      { key: "alignment", label: "Align", align: "right", mono: true },
      { key: "padding", label: "Padding", align: "right", mono: true },
      { key: "option", label: "Option<T>", align: "right", mono: true },
    ],
    rows,
    groupBy: "word",
    compareKey: "size",
  };
}
