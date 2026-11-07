"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnyToolDefinition, ToolResult, ToolSpecBase } from "@sp/engine";
import type { Diagnostic } from "@sp/contracts";
import { runTool } from "./run-tool";

export type ComputeStatus = "blank" | "pending" | "done" | "error";

export interface ComputeState {
  status: ComputeStatus;
  result: ToolResult | undefined;
  diagnostics: Diagnostic<ToolSpecBase>[];
  /** Tags for option visibility, derived from the (debounced) input. */
  tags: string | readonly string[] | undefined;
  /** What the tool's code threw on this input, if it did. */
  failure: string | undefined;
}

const DEBOUNCE_MS = 150;

/**
 * Debounced auto-compute. Layout work is synchronous and cheap, so there is no worker;
 * the hook only debounces typing so a keystroke never re-parses mid-word.
 */
export function useCompute(
  tool: AnyToolDefinition | undefined,
  spec: ToolSpecBase | undefined,
  input: string,
): ComputeState {
  const [debounced, setDebounced] = useState(input);

  useEffect(() => {
    if (debounced === input) return;
    const t = setTimeout(() => setDebounced(input), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input, debounced]);

  const computed = useMemo(() => {
    if (!tool || !spec) return undefined;
    const effectiveInput = tool.readsInput ? debounced : "";
    if (tool.readsInput && effectiveInput.trim() === "") return undefined;
    return runTool(tool, spec, effectiveInput);
  }, [tool, spec, debounced]);

  const pending = tool?.readsInput === true && debounced !== input;

  if (!computed) {
    return { status: pending ? "pending" : "blank", result: undefined, diagnostics: [], tags: undefined, failure: undefined };
  }
  return {
    status: pending ? "pending" : computed.result.error || computed.failure ? "error" : "done",
    ...computed,
  };
}
