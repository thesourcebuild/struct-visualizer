/**
 * The tools this family contributes, as eager metadata. Free of any `@sp/core` import;
 * `../manifest.ts` derives the registry entries from this list.
 */
import type { ToolFamily } from "@sp/engine";
import { TOOL_RUST_STRUCT_LAYOUT, TOOL_RUST_VERIFICATION_CODE } from "../pure";

export interface RustToolMeta {
  id: string;
  label: string;
  family: ToolFamily;
  category: string;
  tags: readonly string[];
  summary: string;
  supportsVariants: boolean;
}

export const RUST_TOOLS: readonly RustToolMeta[] = [
  {
    id: TOOL_RUST_STRUCT_LAYOUT,
    label: "Rust Type Layout",
    family: "rust",
    category: "Calculators",
    tags: ["rust", "struct", "enum", "union", "repr", "niche", "size_of", "align_of", "offset_of"],
    summary:
      "Byte-level layout of a Rust struct, enum or union on any target: rustc's field order, repr(C), packed, and how enums store their discriminant.",
    supportsVariants: true,
  },
  {
    id: TOOL_RUST_VERIFICATION_CODE,
    label: "Rust Verification Code",
    family: "rust",
    category: "Calculators",
    tags: ["rust", "size_of", "offset_of", "codegen"],
    summary: "Generate a Rust program that prints size_of, align_of and offset_of! for every field.",
    supportsVariants: false,
  },
];

export function requireRustTool(id: string): RustToolMeta {
  const tool = RUST_TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown Rust tool: ${id}`);
  return tool;
}
