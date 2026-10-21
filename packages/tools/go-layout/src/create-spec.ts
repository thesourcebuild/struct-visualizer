import type { OptionValues } from "@sp/contracts";
import { GO_TARGETS } from "@sp/core";
import {
  DEFAULT_GO_TARGET,
  OPTION_COMPARE,
  OPTION_EXPLAIN,
  OPTION_GO_TARGET,
  OPTION_MODE,
  SPEC_VERSION,
  readString,
} from "./pure";
import type { GoLayoutSpec } from "./spec";

export function defaultOptions(): OptionValues {
  return {
    [OPTION_GO_TARGET]: DEFAULT_GO_TARGET,
    [OPTION_MODE]: "natural",
    [OPTION_COMPARE]: false,
    [OPTION_EXPLAIN]: false,
  };
}

/** The selected target, falling back to the default for unknown ids (stale links). */
export function readGoTarget(options: OptionValues): string {
  const id = readString(options, OPTION_GO_TARGET, DEFAULT_GO_TARGET);
  return GO_TARGETS.some((t) => t.id === id) ? id : DEFAULT_GO_TARGET;
}

export function normalizeOptions(options: OptionValues): OptionValues {
  return { ...options, [OPTION_GO_TARGET]: readGoTarget(options) };
}

export function createSpec(options: Partial<OptionValues> = {}): GoLayoutSpec {
  const merged: OptionValues = { ...defaultOptions() };
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) merged[k] = v;
  }
  return { specVersion: SPEC_VERSION, options: normalizeOptions(merged) };
}
