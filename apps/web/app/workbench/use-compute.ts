"use client";

import { useEffect, useMemo, useState } from "react";
import { runLint } from "@sp/engine";
import type { AnyToolDefinition, ToolResult, ToolSpecBase } from "@sp/engine";
import type { Diagnostic } from "@sp/contracts";

export type ComputeStatus = "blank" | "pending" | "done" | "error";

export interface ComputeState {
  status: ComputeStatus;
  result: ToolResult | undefined;
  diagnostics: Diagnostic<ToolSpecBase>[];
  /** Tags for option visibility, derived from the (debounced) input. */
  tags: string | readonly string[] | undefined;
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
    let result: ToolResult;
    try {
      result = tool.compute(spec, effectiveInput);
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    const diagnostics = runLint(tool.lintRules, { spec, input: effectiveInput, result });
    const tags = tool.variantTag?.(spec, effectiveInput);
    return { result, diagnostics, tags };
  }, [tool, spec, debounced]);

  const pending = tool?.readsInput === true && debounced !== input;

  if (!computed) {
    return { status: pending ? "pending" : "blank", result: undefined, diagnostics: [], tags: undefined };
  }
  return {
    status: pending ? "pending" : computed.result.error ? "error" : "done",
    ...computed,
  };
}
