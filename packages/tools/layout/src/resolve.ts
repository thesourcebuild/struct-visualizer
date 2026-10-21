import { resolvePlatform } from "@sp/core";
import type { DataModel, OSType, PlatformSelection, ResolvedPlatform } from "@sp/core";
import { readTarget } from "./create-spec";
import {
  OPTION_DATA_MODEL,
  OPTION_ENUM_ALIGN,
  OPTION_ENUM_SIZE,
  OPTION_OS,
  readEnumOverride,
  readString,
} from "./pure";
import type { LayoutSpec } from "./spec";

/**
 * Turns a spec into the platform selection it asks for.
 *
 * Shared by compute, the variants table, the lint rules and `describe`, which is what stops
 * them from disagreeing -- a description naming one ABI while the layout used another would be
 * worse than no description.
 */
export function selectionFromSpec(spec: LayoutSpec): PlatformSelection {
  const { options } = spec;
  return {
    target: readTarget(options),
    dataModel: readString(options, OPTION_DATA_MODEL, "") as DataModel,
    os: readString(options, OPTION_OS, "linux") as OSType,
    enumSize: readEnumOverride(options, OPTION_ENUM_SIZE),
    enumAlign: readEnumOverride(options, OPTION_ENUM_ALIGN),
  };
}

/**
 * The platform that will actually be computed against. A share link or stale saved state can
 * name a data model or OS the target does not support; `resolvePlatform` clamps those to the
 * target's defaults rather than refusing to render anything.
 */
export function resolveSpec(spec: LayoutSpec): ResolvedPlatform {
  return resolvePlatform(selectionFromSpec(spec));
}
