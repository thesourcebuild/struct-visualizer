"use client";

import type { AnyToolDefinition } from "@sp/engine";
import { zigToolDefinition } from "@sp/zig-layout/definition";
import { TOOL_ZIG_STRUCT_LAYOUT } from "@sp/zig-layout";
import { ZigLayoutResult } from "./zig-layout-result";
import type { ToolFamilyModule } from "./tool-definitions";

/**
 * Everything the workbench needs for the Zig tools: their definitions and the result view
 * that is not the generic one. A page of this language imports it up front (shell-zig.tsx);
 * other pages load it when one of these tools is opened.
 */
const cache = new Map<string, AnyToolDefinition>();

export const family: ToolFamilyModule = {
  definition(id) {
    let t = cache.get(id);
    if (!t) {
      t = zigToolDefinition(id) as unknown as AnyToolDefinition;
      cache.set(id, t);
    }
    return t;
  },
  resultViews: { [TOOL_ZIG_STRUCT_LAYOUT]: ZigLayoutResult },
};
