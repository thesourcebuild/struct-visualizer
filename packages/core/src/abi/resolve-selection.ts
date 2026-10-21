import type { DataType } from '../types';
import { architectures } from './architectures';
import {
  dataModels,
  getArchitectureId,
  getDefaultDataModelForArchitecture,
  getSupportedOSTypes,
  getValidDataModelsForArchitecture,
  resolveArchitectureForSelection,
  targetArchitectureList,
} from './data-models';
import type { DataModel, OSType, ResolvedArchitecture, TargetArchitecture } from './data-models';

export type EnumOverride = 'default' | '1' | '2' | '4' | '8';

export interface PlatformSelection {
  target: TargetArchitecture;
  dataModel: DataModel;
  os: OSType;
  enumSize?: EnumOverride;
  enumAlign?: EnumOverride;
}

export interface ResolvedPlatform {
  target: TargetArchitecture;
  /** Data model after clamping to the models valid for `target`. */
  dataModel: DataModel;
  /** OS after clamping to the OS types supported by `target`. */
  os: OSType;
  /** Base architecture id (x86, x64, arm32, ...). */
  architectureId: string;
  architecture: ResolvedArchitecture;
  /** Enum size/alignment the data model uses when no override is set. */
  defaultEnumSize: number;
}

/** Clamp a data model to one valid for the target, falling back to the target's default. */
export function clampDataModel(target: TargetArchitecture, dataModel: DataModel): DataModel {
  return getValidDataModelsForArchitecture(target).includes(dataModel)
    ? dataModel
    : getDefaultDataModelForArchitecture(target);
}

/** Clamp an OS to one supported by the target, falling back to the first supported OS. */
export function clampOSType(target: TargetArchitecture, os: OSType): OSType {
  const supported = getSupportedOSTypes(target);
  return supported.includes(os) ? os : (supported[0] ?? 'linux');
}

/**
 * Single path from a UI/spec selection to the architecture the calculator runs against:
 * clamps invalid model/OS combinations, applies ABI overrides, then any enum override.
 */
export function resolvePlatform(selection: PlatformSelection): ResolvedPlatform {
  const { target } = selection;
  const dataModel = clampDataModel(target, selection.dataModel);
  const os = clampOSType(target, selection.os);
  const architectureId = getArchitectureId(dataModel, target, os);
  const base = architectures[architectureId] ?? architectures.x64!;
  const resolved = resolveArchitectureForSelection(base, dataModel, target, os);

  const defaultEnumSize = dataModels[dataModel]?.dataTypes.enumSize ?? 4;
  const enumSize = selection.enumSize ?? 'default';
  const enumAlign = selection.enumAlign ?? 'default';

  if (enumSize === 'default' && enumAlign === 'default') {
    return { target, dataModel, os, architectureId, architecture: resolved, defaultEnumSize };
  }

  const enumType: DataType = {
    name: 'enum',
    size: enumSize === 'default' ? defaultEnumSize : Number(enumSize),
    alignment: enumAlign === 'default' ? defaultEnumSize : Number(enumAlign),
    category: 'primitive',
  };

  return {
    target,
    dataModel,
    os,
    architectureId,
    // Keep ABI overrides (e.g. i386 SysV 4-byte double alignment) alongside the enum override.
    architecture: { ...resolved, dataTypes: { ...(resolved.dataTypes ?? {}), enum: enumType } },
    defaultEnumSize,
  };
}

/** Every valid target × data model × OS combination, in catalogue order. */
export function allPlatformCombinations(): Array<Pick<PlatformSelection, 'target' | 'dataModel' | 'os'>> {
  const combos: Array<Pick<PlatformSelection, 'target' | 'dataModel' | 'os'>> = [];
  for (const { id: target } of targetArchitectureList) {
    for (const dataModel of getValidDataModelsForArchitecture(target)) {
      for (const os of getSupportedOSTypes(target)) {
        combos.push({ target, dataModel, os });
      }
    }
  }
  return combos;
}
