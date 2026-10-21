import type { ComponentType } from "react";
import type { ToolResult, ToolSpecBase } from "@sp/engine";
import { TOOL_GO_STRUCT_LAYOUT } from "@sp/go-layout";
import { TOOL_STRUCT_LAYOUT } from "@sp/layout";
import { TOOL_RUST_STRUCT_LAYOUT } from "@sp/rust-layout";
import { GoLayoutResult } from "./go-layout-result";
import { LayoutResult } from "./layout-result";
import { RustLayoutResult } from "./rust-layout-result";

export interface CustomResultProps {
  result: ToolResult;
  spec: ToolSpecBase;
  input: string;
}

/**
 * Tools whose result needs a bespoke view. Everything else (options, input, diagnostics,
 * variants) still comes from the generic workbench; tools not listed use ResultPanel.
 */
export const CUSTOM_RESULTS: Partial<Record<string, ComponentType<CustomResultProps>>> = {
  [TOOL_STRUCT_LAYOUT]: LayoutResult,
  [TOOL_GO_STRUCT_LAYOUT]: GoLayoutResult,
  [TOOL_RUST_STRUCT_LAYOUT]: RustLayoutResult,
};
