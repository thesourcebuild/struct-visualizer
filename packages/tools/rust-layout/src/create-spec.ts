import type { OptionValues } from "@sp/contracts";
import { RUST_TARGETS } from "@sp/core";
import {
  DEFAULT_RUST_TARGET,
  OPTION_COMPARE,
  OPTION_EXPLAIN,
  OPTION_MODE,
  OPTION_RUST_TARGET,
  SPEC_VERSION,
  readString,
} from "./pure";
import type { RustLayoutSpec } from "./spec";

export function defaultOptions(): OptionValues {
  return {
    [OPTION_RUST_TARGET]: DEFAULT_RUST_TARGET,
    [OPTION_MODE]: "natural",
    [OPTION_COMPARE]: false,
    [OPTION_EXPLAIN]: false,
  };
}

/** The selected target, falling back to the default for unknown ids (stale links). */
export function readRustTarget(options: OptionValues): string {
  const id = readString(options, OPTION_RUST_TARGET, DEFAULT_RUST_TARGET);
  return RUST_TARGETS.some((t) => t.id === id) ? id : DEFAULT_RUST_TARGET;
}

export function normalizeOptions(options: OptionValues): OptionValues {
  return { ...options, [OPTION_RUST_TARGET]: readRustTarget(options) };
}

export function createSpec(options: Partial<OptionValues> = {}): RustLayoutSpec {
  const merged: OptionValues = { ...defaultOptions() };
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) merged[k] = v;
  }
  return { specVersion: SPEC_VERSION, options: normalizeOptions(merged) };
}
