"use client";

import type { AnyToolDefinition } from "@sp/engine";
import { goToolDefinition } from "@sp/go-layout/definition";
import { TOOL_GO_STRUCT_LAYOUT } from "@sp/go-layout";
import { GoLayoutResult } from "./go-layout-result";
import type { ToolFamilyModule } from "./tool-definitions";

/**
 * Everything the workbench needs for the Go tools: their definitions and the result view
 * that is not the generic one. A page of this language imports it up front (shell-go.tsx);
 * other pages load it when one of these tools is opened.
 */
const cache = new Map<string, AnyToolDefinition>();

export const family: ToolFamilyModule = {
  definition(id) {
    let t = cache.get(id);
    if (!t) {
      t = goToolDefinition(id) as unknown as AnyToolDefinition;
      cache.set(id, t);
    }
    return t;
  },
  resultViews: { [TOOL_GO_STRUCT_LAYOUT]: GoLayoutResult },
};
