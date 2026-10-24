/**
 * The tools this family contributes, as eager metadata. Free of any `@sp/core` import;
 * `../manifest.ts` derives the registry entries from this list.
 */
import type { ToolFamily } from "@sp/engine";
import { TOOL_ZIG_STRUCT_LAYOUT, TOOL_ZIG_VERIFICATION_CODE } from "../pure";

export interface ZigToolMeta {
  id: string;
  label: string;
  family: ToolFamily;
  category: string;
  tags: readonly string[];
  summary: string;
  supportsVariants: boolean;
}

export const ZIG_TOOLS: readonly ZigToolMeta[] = [
  {
    id: TOOL_ZIG_STRUCT_LAYOUT,
    label: "Zig Type Layout",
    family: "zig",
    category: "Calculators",
    tags: ["zig", "struct", "union", "enum", "extern", "packed", "@sizeOf", "@alignOf", "@offsetOf"],
    summary:
      "Byte-level layout of a Zig struct, union or enum on any target: the field order Zig picks, extern and packed layouts, tagged unions, optionals and error unions.",
    supportsVariants: true,
  },
  {
    id: TOOL_ZIG_VERIFICATION_CODE,
    label: "Zig Verification Code",
    family: "zig",
    category: "Calculators",
    tags: ["zig", "@sizeOf", "@offsetOf", "codegen"],
    summary: "Generate a Zig program that prints @sizeOf, @alignOf and @offsetOf for every field.",
    supportsVariants: false,
  },
];

export function requireZigTool(id: string): ZigToolMeta {
  const tool = ZIG_TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown Zig tool: ${id}`);
  return tool;
}
