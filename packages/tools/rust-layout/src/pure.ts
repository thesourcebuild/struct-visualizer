/**
 * Zod-free constants and option accessors. Safe to import from the eager manifest path
 * and from the UI without pulling in schema construction or the layout engine.
 */
import type { OptionValues } from "@sp/contracts";

export const SPEC_VERSION = 1;

/** Target triple. */
export const OPTION_RUST_TARGET = "rustTarget";
export const OPTION_MODE = "mode";
export const OPTION_COMPARE = "compare";
export const OPTION_EXPLAIN = "explain";

export type RustLayoutMode = "natural" | "optimized";

/** The definition is a repr(C) struct whose fields could be reordered. */
export const TAG_REORDERABLE = "reorderable";
export const TAG_OPTIMIZED = "optimized";

export const DEFAULT_RUST_TARGET = "x86_64-unknown-linux-gnu";

export const TOOL_RUST_STRUCT_LAYOUT = "rust-struct-layout";
export const TOOL_RUST_VERIFICATION_CODE = "rust-verification-code";

export function readString(options: OptionValues, id: string, fallback: string): string {
  const v = options[id];
  return typeof v === "string" ? v : fallback;
}

export function readMode(options: OptionValues): RustLayoutMode {
  return readString(options, OPTION_MODE, "natural") === "optimized" ? "optimized" : "natural";
}

export function withOption<T extends { options: OptionValues }>(
  spec: T,
  id: string,
  value: string | number | boolean,
): T {
  return { ...spec, options: { ...spec.options, [id]: value } };
}
