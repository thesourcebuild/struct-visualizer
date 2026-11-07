import type { OptionValues } from "@sp/contracts";
import {
  clampDataModel,
  clampOSType,
  dataModelList,
  getDefaultDataModelForArchitecture,
  osTypeList,
  resolvePackingSyntax,
  targetArchitectureList,
} from "@sp/core";
import type { DataModel, OSType, TargetArchitecture } from "@sp/core";
import {
  DEFAULT_OS,
  DEFAULT_REFERENCE_MODEL,
  DEFAULT_TARGET,
  OPTION_BINDING_LANGUAGE,
  OPTION_COMPARE,
  OPTION_DATA_MODEL,
  OPTION_ENUM_ALIGN,
  OPTION_ENUM_SIZE,
  OPTION_EXPLAIN,
  OPTION_LANGUAGE,
  OPTION_MODE,
  OPTION_OS,
  OPTION_PACKING,
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
    [OPTION_PACKING]: "attribute",
    [OPTION_COMPARE]: false,
    [OPTION_EXPLAIN]: false,
    [OPTION_ENUM_SIZE]: "default",
    [OPTION_ENUM_ALIGN]: "default",
    [OPTION_LANGUAGE]: "c",
    [OPTION_REFERENCE_MODEL]: DEFAULT_REFERENCE_MODEL,
    [OPTION_BINDING_LANGUAGE]: "rust",
  };
}

/** The selected target, falling back to the default for unknown ids (stale links). */
export function readTarget(options: OptionValues): TargetArchitecture {
  const id = readString(options, OPTION_TARGET, DEFAULT_TARGET);
  return targetArchitectureList.find((t) => t.id === id)?.id ?? DEFAULT_TARGET;
}

/** The selected OS, falling back to the default for unknown ids; clamp it to the target after. */
export function readOS(options: OptionValues): OSType {
  const id = readString(options, OPTION_OS, DEFAULT_OS);
  return osTypeList.find((o) => o.id === id)?.id ?? DEFAULT_OS;
}

/** Data-models reference tool: the model whose types are listed, LP64 for unknown ids. */
export function readReferenceModel(options: OptionValues): DataModel {
  const id = readString(options, OPTION_REFERENCE_MODEL, DEFAULT_REFERENCE_MODEL);
  return dataModelList.find((m) => m.id === id)?.id ?? DEFAULT_REFERENCE_MODEL;
}

/**
 * Clamp model/OS to what the target supports, and the packing syntax to what that compiler
 * accepts (MSVC and the 8051 compilers: only #pragma pack), so every spec the UI holds is valid.
 */
export function normalizeOptions(options: OptionValues): OptionValues {
  const target = readTarget(options);
  const dataModel = clampDataModel(target, readString(options, OPTION_DATA_MODEL, "") as DataModel);
  const os = clampOSType(target, readOS(options));
  const packing = resolvePackingSyntax(os, dataModel, readString(options, OPTION_PACKING, "attribute"));
  return {
    ...options,
    [OPTION_TARGET]: target,
    [OPTION_DATA_MODEL]: dataModel,
    [OPTION_OS]: os,
    [OPTION_PACKING]: packing,
    [OPTION_REFERENCE_MODEL]: readReferenceModel(options),
  };
}

export function createSpec(options: Partial<OptionValues> = {}): LayoutSpec {
  const merged: OptionValues = { ...defaultOptions() };
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) merged[k] = v;
  }
  return { specVersion: SPEC_VERSION, options: normalizeOptions(merged) };
}
