/**
 * The tools this family contributes, as eager metadata. Free of any `@sp/core` import;
 * `../manifest.ts` derives the registry entries from this list.
 */
import type { ToolFamily } from "@sp/engine";
import { TOOL_GO_STRUCT_LAYOUT, TOOL_GO_VERIFICATION_CODE } from "../pure";

export interface GoToolMeta {
  id: string;
  label: string;
  family: ToolFamily;
  category: string;
  tags: readonly string[];
  summary: string;
  supportsVariants: boolean;
}

export const GO_TOOLS: readonly GoToolMeta[] = [
  {
    id: TOOL_GO_STRUCT_LAYOUT,
    label: "Go Struct Layout",
    family: "go",
    category: "Calculators",
    tags: ["go", "golang", "struct", "padding", "alignment", "unsafe.Sizeof", "fieldalignment"],
    summary:
      "Byte-level memory layout of a Go struct for any GOARCH: offsets, padding and the field order fieldalignment suggests.",
    supportsVariants: true,
  },
  {
    id: TOOL_GO_VERIFICATION_CODE,
    label: "Go Verification Code",
    family: "go",
    category: "Calculators",
    tags: ["go", "unsafe.Sizeof", "unsafe.Offsetof", "codegen"],
    summary: "Generate a Go program that prints unsafe.Sizeof, Alignof and Offsetof for every field.",
    supportsVariants: false,
  },
];

export function requireGoTool(id: string): GoToolMeta {
  const tool = GO_TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown Go tool: ${id}`);
  return tool;
}
