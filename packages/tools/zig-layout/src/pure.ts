/**
 * Zod-free constants and option accessors. Safe to import from the eager manifest path
 * and from the UI without pulling in schema construction or the layout engine.
 */
import type { OptionValues } from "@sp/contracts";

export const SPEC_VERSION = 1;

/** What -target takes. */
export const OPTION_ZIG_TARGET = "zigTarget";
/** -mcpu, for x86-64 targets: the microarchitecture level. */
export const OPTION_ZIG_CPU = "zigCpu";
/** --error-limit: the number of error names, which sizes error codes. */
export const OPTION_ERROR_LIMIT = "errorLimit";
/** zig's default: error codes are u16. */
export const DEFAULT_ERROR_LIMIT = 65535;
/** -O: Debug, ReleaseSafe, ReleaseFast or ReleaseSmall. */
export const OPTION_BUILD_MODE = "buildMode";
export const OPTION_MODE = "mode";
export const OPTION_COMPARE = "compare";
export const OPTION_EXPLAIN = "explain";

export type ZigLayoutMode = "natural" | "optimized";
export type ZigBuildModeId = "Debug" | "ReleaseSafe" | "ReleaseFast" | "ReleaseSmall";
export const BUILD_MODE_IDS: readonly ZigBuildModeId[] = ["Debug", "ReleaseSafe", "ReleaseFast", "ReleaseSmall"];

/** The definition is an extern struct whose fields could be reordered. */
export const TAG_REORDERABLE = "reorderable";
export const TAG_OPTIMIZED = "optimized";
/** The target is x86-64, which has CPU levels to choose from. */
export const TAG_X86_64 = "x86_64";

export const DEFAULT_ZIG_TARGET = "x86_64-linux-gnu";
export const DEFAULT_BUILD_MODE: ZigBuildModeId = "Debug";
export const DEFAULT_ZIG_CPU = "x86_64";

export const TOOL_ZIG_STRUCT_LAYOUT = "zig-struct-layout";
export const TOOL_ZIG_VERIFICATION_CODE = "zig-verification-code";

export function readString(options: OptionValues, id: string, fallback: string): string {
  const v = options[id];
  return typeof v === "string" ? v : fallback;
}

export function readMode(options: OptionValues): ZigLayoutMode {
  return readString(options, OPTION_MODE, "natural") === "optimized" ? "optimized" : "natural";
}

export function readBuildMode(options: OptionValues): ZigBuildModeId {
  const v = readString(options, OPTION_BUILD_MODE, DEFAULT_BUILD_MODE);
  return (BUILD_MODE_IDS as readonly string[]).includes(v) ? (v as ZigBuildModeId) : DEFAULT_BUILD_MODE;
}

export function withOption<T extends { options: OptionValues }>(
  spec: T,
  id: string,
  value: string | number | boolean,
): T {
  return { ...spec, options: { ...spec.options, [id]: value } };
}
