import {
  allPlatformCombinations,
  analyzeStruct,
  dataModels,
  osTypes,
  resolvePlatform,
  targetArchitectures,
} from "@sp/core";
import type { ToolVariantRow, ToolVariantTable } from "@sp/engine";
import { selectionFromSpec } from "./resolve";
import { OPTION_DATA_MODEL, OPTION_OS, OPTION_TARGET, readLanguage, readMode, readPacking } from "./pure";
import type { LayoutSpec } from "./spec";

/** The same struct laid out on every valid target × data model × OS. */
export function layoutVariants(spec: LayoutSpec, input: string): ToolVariantTable {
  const selection = selectionFromSpec(spec);
  // The spec may hold a model/OS that gets clamped; highlight the clamped combination.
  const current = resolvePlatform(selection);
  const mode = readMode(spec.options);

  const rows: ToolVariantRow[] = allPlatformCombinations().map((combo) => {
    // Each combination packs in the chosen syntax if its compiler accepts it (MSVC: #pragma pack).
    const analysis = analyzeStruct(input, { ...selection, ...combo }, { packing: readPacking(spec.options), language: readLanguage(spec.options) });
    const r =
      mode === "packed"
        ? analysis.packed
        : mode === "optimized"
          ? analysis.optimized
          : analysis.result;

    return {
      cells: {
        target: targetArchitectures[combo.target]?.displayName ?? combo.target,
        dataModel: dataModels[combo.dataModel]?.displayName ?? combo.dataModel,
        os: osTypes[combo.os]?.displayName ?? combo.os,
        size: r ? r.totalSize : "—",
        alignment: r ? (r.struct.alignment ?? 1) : "—",
        padding: r ? r.totalPadding : "—",
        efficiency: r ? `${r.efficiency.toFixed(1)}%` : "—",
      },
      options: {
        [OPTION_TARGET]: combo.target,
        [OPTION_DATA_MODEL]: combo.dataModel,
        [OPTION_OS]: combo.os,
      },
      current:
        combo.target === current.target &&
        combo.dataModel === current.dataModel &&
        combo.os === current.os,
      error: analysis.errors[0]?.message,
    };
  });

  return {
    title: "Across platforms",
    summary: `The same definition on every supported target, data model and OS (${mode} layout). Click a row to switch to it.`,
    columns: [
      { key: "target", label: "Architecture" },
      { key: "dataModel", label: "Data model" },
      { key: "os", label: "OS" },
      { key: "size", label: "Size", align: "right", mono: true },
      { key: "alignment", label: "Align", align: "right", mono: true },
      { key: "padding", label: "Padding", align: "right", mono: true },
      { key: "efficiency", label: "Efficiency", align: "right", mono: true },
    ],
    rows,
    groupBy: "target",
    compareKey: "size",
  };
}
