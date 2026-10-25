import { ZIG_TARGETS, analyzeZig, zigPointerBits } from "@sp/core";
import type { ToolVariantRow, ToolVariantTable } from "@sp/engine";
import { readBuild, readZigTarget } from "./create-spec";
import { OPTION_ZIG_TARGET, readMode } from "./pure";
import type { ZigLayoutSpec } from "./spec";

/** The same definition on every Zig target, in the selected build mode. */
export function zigLayoutVariants(spec: ZigLayoutSpec, input: string): ToolVariantTable {
  const current = readZigTarget(spec.options);
  const mode = readMode(spec.options);
  const build = readBuild(spec.options);

  const rows: ToolVariantRow[] = ZIG_TARGETS.map((target) => {
    // The x86-64 level applies to the x86-64 targets; the others have their own CPU.
    const a = analyzeZig(input, target.id, build);
    const r = mode === "optimized" ? (a.optimized ?? a.result) : a.result;
    return {
      cells: {
        word: `${zigPointerBits(target)}-bit`,
        target: target.label,
        size: r ? r.totalSize : "—",
        alignment: r ? (r.struct.alignment ?? 1) : "—",
        padding: r ? r.totalPadding : "—",
        optional: a.optionalSize ?? "—",
      },
      options: { [OPTION_ZIG_TARGET]: target.id },
      current: target.id === current,
      error: a.errors[0]?.message,
    };
  });

  return {
    title: "Across targets",
    summary: `The same definition on every target, built ${build.mode}. Click a row to switch to it.`,
    columns: [
      { key: "word", label: "Pointer" },
      { key: "target", label: "Target" },
      { key: "size", label: "Size", align: "right", mono: true },
      { key: "alignment", label: "Align", align: "right", mono: true },
      { key: "padding", label: "Padding", align: "right", mono: true },
      { key: "optional", label: "?T", align: "right", mono: true },
    ],
    rows,
    groupBy: "word",
    compareKey: "size",
  };
}
