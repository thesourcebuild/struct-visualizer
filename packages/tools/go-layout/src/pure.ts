/**
 * Zod-free constants and option accessors. Safe to import from the eager manifest path
 * and from the UI without pulling in schema construction or the layout engine.
 */
import type { OptionValues } from "@sp/contracts";

export const SPEC_VERSION = 1;

/** GOARCH (gc) or TinyGo target id. */
export const OPTION_GO_TARGET = "goTarget";
export const OPTION_MODE = "mode";
export const OPTION_COMPARE = "compare";
export const OPTION_EXPLAIN = "explain";

export type GoLayoutMode = "natural" | "optimized";

export const TAG_OPTIMIZED = "optimized";

export const DEFAULT_GO_TARGET = "amd64";

export const TOOL_GO_STRUCT_LAYOUT = "go-struct-layout";
export const TOOL_GO_VERIFICATION_CODE = "go-verification-code";

export function readString(options: OptionValues, id: string, fallback: string): string {
  const v = options[id];
  return typeof v === "string" ? v : fallback;
}

export function readMode(options: OptionValues): GoLayoutMode {
  return readString(options, OPTION_MODE, "natural") === "optimized" ? "optimized" : "natural";
}

export function withOption<T extends { options: OptionValues }>(
  spec: T,
  id: string,
  value: string | number | boolean,
): T {
  return { ...spec, options: { ...spec.options, [id]: value } };
}
