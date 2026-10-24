/**
 * Zod-free constants and option accessors. Safe to import from the eager manifest path
 * and from the UI without pulling in schema construction or the layout engine.
 */
import type { OptionValues } from "@sp/contracts";

export const SPEC_VERSION = 1;

export const OPTION_TARGET = "target";
export const OPTION_DATA_MODEL = "dataModel";
export const OPTION_OS = "os";
export const OPTION_MODE = "mode";
export const OPTION_COMPARE = "compare";
export const OPTION_ENUM_SIZE = "enumSize";
export const OPTION_ENUM_ALIGN = "enumAlign";
export const OPTION_LANGUAGE = "language";
export const OPTION_EXPLAIN = "explain";
/** How Packed mode writes the packing: "attribute", "pragma" or "keyword" (see @sp/core packing). */
export const OPTION_PACKING = "packing";
/** Data-models reference tool: which model's type table to show (not clamped to a target). */
export const OPTION_REFERENCE_MODEL = "referenceModel";

export type LayoutMode = "natural" | "packed" | "optimized";
/** The source language: C, or C++ by the standard whose layout rules apply. */
export type CodeLanguage = "c" | "c++17" | "c++20";
export type EnumOverride = "default" | "1" | "2" | "4" | "8";

/** Variant tags driving option visibility (OptionDef.availableOn). */
export const TAG_HAS_ENUM = "has-enum";
export const TAG_OS_SELECTABLE = "os-selectable";
export const TAG_OPTIMIZED = "optimized";
export const TAG_PACKED = "packed";

export const DEFAULT_TARGET = "intel-x64-amd";
export const DEFAULT_OS = "linux";

export const TOOL_STRUCT_LAYOUT = "struct-layout";
export const TOOL_VERIFICATION_CODE = "verification-code";
export const TOOL_BINDINGS = "bindings";
export const TOOL_DATA_MODELS = "data-models";

/** Bindings tool: the language the struct is written out in. */
export const OPTION_BINDING_LANGUAGE = "bindingLanguage";
export type BindingLanguageId = "rust" | "zig" | "go" | "csharp" | "python-struct" | "python-ctypes";
export const BINDING_LANGUAGE_IDS: readonly BindingLanguageId[] = ["rust", "zig", "go", "csharp", "python-struct", "python-ctypes"];

export function readBindingLanguage(options: OptionValues): BindingLanguageId {
  const v = readString(options, OPTION_BINDING_LANGUAGE, "rust");
  return (BINDING_LANGUAGE_IDS as readonly string[]).includes(v) ? (v as BindingLanguageId) : "rust";
}

export function readString(options: OptionValues, id: string, fallback: string): string {
  const v = options[id];
  return typeof v === "string" ? v : fallback;
}

export function readBoolean(options: OptionValues, id: string, fallback = false): boolean {
  const v = options[id];
  return typeof v === "boolean" ? v : fallback;
}

export function readMode(options: OptionValues): LayoutMode {
  const v = readString(options, OPTION_MODE, "natural");
  return v === "packed" || v === "optimized" ? v : "natural";
}

/** The packing syntax asked for; the core clamps it to what the target's compiler accepts. */
export function readPacking(options: OptionValues): "attribute" | "pragma" | "keyword" {
  const v = readString(options, OPTION_PACKING, "attribute");
  return v === "pragma" || v === "keyword" ? v : "attribute";
}

export function readLanguage(options: OptionValues): CodeLanguage {
  const v = readString(options, OPTION_LANGUAGE, "c");
  return v === "c++17" || v === "c++20" ? v : "c";
}

export function readEnumOverride(options: OptionValues, id: string): EnumOverride {
  const v = readString(options, id, "default");
  return v === "1" || v === "2" || v === "4" || v === "8" ? v : "default";
}

export function withOption<T extends { options: OptionValues }>(
  spec: T,
  id: string,
  value: string | number | boolean,
): T {
  return { ...spec, options: { ...spec.options, [id]: value } };
}
