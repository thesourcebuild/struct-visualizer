import type { OptionValues } from "@sp/contracts";
import { ZIG_TARGETS, ZIG_X86_64_CPUS } from "@sp/core";
import {
  DEFAULT_BUILD_MODE,
  DEFAULT_ZIG_CPU,
  DEFAULT_ZIG_TARGET,
  OPTION_BUILD_MODE,
  OPTION_COMPARE,
  OPTION_EXPLAIN,
  OPTION_MODE,
  OPTION_ZIG_CPU,
  OPTION_ZIG_TARGET,
  SPEC_VERSION,
  readBuildMode,
  readString,
} from "./pure";
import type { ZigLayoutSpec } from "./spec";

export function defaultOptions(): OptionValues {
  return {
    [OPTION_ZIG_TARGET]: DEFAULT_ZIG_TARGET,
    [OPTION_BUILD_MODE]: DEFAULT_BUILD_MODE,
    [OPTION_ZIG_CPU]: DEFAULT_ZIG_CPU,
    [OPTION_MODE]: "natural",
    [OPTION_COMPARE]: false,
    [OPTION_EXPLAIN]: false,
  };
}

/** The selected target, falling back to the default for unknown ids (stale links). */
export function readZigTarget(options: OptionValues): string {
  const id = readString(options, OPTION_ZIG_TARGET, DEFAULT_ZIG_TARGET);
  return ZIG_TARGETS.some((t) => t.id === id) ? id : DEFAULT_ZIG_TARGET;
}

/** The selected x86-64 level, falling back to the baseline for unknown ids. */
export function readZigCpu(options: OptionValues): string {
  const id = readString(options, OPTION_ZIG_CPU, DEFAULT_ZIG_CPU);
  return ZIG_X86_64_CPUS.some((c) => c.id === id) ? id : DEFAULT_ZIG_CPU;
}

export function normalizeOptions(options: OptionValues): OptionValues {
  return { ...options, [OPTION_ZIG_TARGET]: readZigTarget(options), [OPTION_BUILD_MODE]: readBuildMode(options), [OPTION_ZIG_CPU]: readZigCpu(options) };
}

export function createSpec(options: Partial<OptionValues> = {}): ZigLayoutSpec {
  const merged: OptionValues = { ...defaultOptions() };
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) merged[k] = v;
  }
  return { specVersion: SPEC_VERSION, options: normalizeOptions(merged) };
}
