"use client";

import type { AnyToolDefinition } from "@sp/engine";
import { rustToolDefinition } from "@sp/rust-layout/definition";
import { TOOL_RUST_STRUCT_LAYOUT } from "@sp/rust-layout";
import { RustLayoutResult } from "./rust-layout-result";
import type { ToolFamilyModule } from "./tool-definitions";

/**
 * Everything the workbench needs for the Rust tools: their definitions and the result view
 * that is not the generic one. A page of this language imports it up front (shell-rust.tsx);
 * other pages load it when one of these tools is opened.
 */
const cache = new Map<string, AnyToolDefinition>();

export const family: ToolFamilyModule = {
  definition(id) {
    let t = cache.get(id);
    if (!t) {
      t = rustToolDefinition(id) as unknown as AnyToolDefinition;
      cache.set(id, t);
    }
    return t;
  },
  resultViews: { [TOOL_RUST_STRUCT_LAYOUT]: RustLayoutResult },
};
