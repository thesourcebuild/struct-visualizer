import type { OptionValues } from "@sp/contracts";
import {
  clampDataModel,
  clampOSType,
  getDefaultDataModelForArchitecture,
  targetArchitectures,
} from "@sp/core";
import type { DataModel, OSType, TargetArchitecture } from "@sp/core";
import {
  DEFAULT_OS,
  DEFAULT_TARGET,
  OPTION_COMPARE,
  OPTION_DATA_MODEL,
  OPTION_ENUM_ALIGN,
  OPTION_ENUM_SIZE,
  OPTION_EXPLAIN,
  OPTION_LANGUAGE,
  OPTION_MODE,
  OPTION_OS,
  OPTION_REFERENCE_MODEL,
  OPTION_TARGET,
  SPEC_VERSION,
  readString,
} from "./pure";
import type { LayoutSpec } from "./spec";

export function defaultOptions(): OptionValues {
  return {
    [OPTION_TARGET]: DEFAULT_TARGET,
    [OPTION_DATA_MODEL]: getDefaultDataModelForArchitecture(DEFAULT_TARGET),
    [OPTION_OS]: DEFAULT_OS,
    [OPTION_MODE]: "natural",
    [OPTION_COMPARE]: false,
    [OPTION_EXPLAIN]: false,
    [OPTION_ENUM_SIZE]: "default",
    [OPTION_ENUM_ALIGN]: "default",
    [OPTION_LANGUAGE]: "c",
    [OPTION_REFERENCE_MODEL]: "LP64",
  };
}

export function readTarget(options: OptionValues): TargetArchitecture {
  const v = readString(options, OPTION_TARGET, DEFAULT_TARGET);
  return v in targetArchitectures ? (v as TargetArchitecture) : DEFAULT_TARGET;
}

/** Clamp model/OS to what the target supports, so every spec the UI holds is valid. */
export function normalizeOptions(options: OptionValues): OptionValues {
  const target = readTarget(options);
  const dataModel = clampDataModel(target, readString(options, OPTION_DATA_MODEL, "") as DataModel);
  const os = clampOSType(target, readString(options, OPTION_OS, DEFAULT_OS) as OSType);
  return { ...options, [OPTION_TARGET]: target, [OPTION_DATA_MODEL]: dataModel, [OPTION_OS]: os };
}

export function createSpec(options: Partial<OptionValues> = {}): LayoutSpec {
  const merged: OptionValues = { ...defaultOptions() };
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) merged[k] = v;
  }
  return { specVersion: SPEC_VERSION, options: normalizeOptions(merged) };
}
