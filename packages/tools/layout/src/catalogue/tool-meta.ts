/**
 * The tools this family contributes, as eager metadata.
 *
 * Free of any `@sp/core` import, so listing these costs nothing but the strings. The engine
 * itself is reached only from `../definition.ts`. `../manifest.ts` derives the registry's
 * ToolManifest entries from this list, so a tool is declared exactly once.
 */
import type { ToolFamily } from "@sp/engine";
import { TOOL_BINDINGS, TOOL_DATA_MODELS, TOOL_STRUCT_LAYOUT, TOOL_VERIFICATION_CODE } from "../pure";

export interface LayoutToolMeta {
  id: string;
  label: string;
  family: ToolFamily;
  category: string;
  tags: readonly string[];
  summary: string;
  /** False for reference tools that compute from options alone. */
  readsInput: boolean;
  /** Whether the tool can lay the same input out across every platform. */
  supportsVariants: boolean;
}

export const LAYOUT_TOOLS: readonly LayoutToolMeta[] = [
  {
    id: TOOL_STRUCT_LAYOUT,
    label: "Struct Layout",
    family: "layout",
    category: "Calculators",
    tags: ["struct", "union", "padding", "alignment", "offsetof", "sizeof", "packed"],
    summary:
      "Byte-level memory layout of a C/C++ struct or union: offsets, padding, alignment and an optimized member order.",
    readsInput: true,
    supportsVariants: true,
  },
  {
    id: TOOL_VERIFICATION_CODE,
    label: "Verification Code",
    family: "layout",
    category: "Calculators",
    tags: ["sizeof", "offsetof", "codegen", "gcc", "g++"],
    summary:
      "Generate a C or C++ program that prints sizeof and offsetof for every member, to check results against your compiler.",
    readsInput: true,
    supportsVariants: false,
  },
  {
    id: TOOL_BINDINGS,
    label: "Bindings",
    family: "layout",
    category: "Calculators",
    tags: ["ffi", "bindings", "rust", "zig", "go", "c#", "python", "ctypes", "repr(C)"],
    summary:
      "Write a C struct in Rust, Zig, Go, C# or Python with exactly the same size and member offsets on the selected target.",
    readsInput: true,
    supportsVariants: false,
  },
  {
    id: TOOL_DATA_MODELS,
    label: "Data Models",
    family: "reference",
    category: "Reference",
    tags: ["LP64", "LLP64", "ILP32", "data model", "ABI"],
    summary:
      "Reference table of C data models (LP64, LLP64, ILP32, embedded compiler models) and the targets that use them.",
    readsInput: false,
    supportsVariants: false,
  },
];

export function getLayoutTool(id: string): LayoutToolMeta | undefined {
  return LAYOUT_TOOLS.find((t) => t.id === id);
}

export function requireLayoutTool(id: string): LayoutToolMeta {
  const tool = getLayoutTool(id);
  if (!tool) throw new Error(`Unknown layout tool: ${id}`);
  return tool;
}
