import {
  dataModelList,
  dataModels,
  getStandardTypeMap,
  getValidDataModelsForArchitecture,
  osTypes,
  targetArchitectureList,
} from "@sp/core";
import type { DataModel } from "@sp/core";
import type { ToolResult, ToolTable } from "@sp/engine";
import { OPTION_REFERENCE_MODEL, readString } from "./pure";
import type { LayoutSpec } from "./spec";

const TYPE_CATEGORIES: Record<string, readonly string[]> = {
  "Integer (char)": ["char", "signed char", "unsigned char", "int8_t", "uint8_t", "u8", "i8"],
  "Integer (short)": ["short", "unsigned short", "int16_t", "uint16_t", "u16", "i16"],
  "Integer (int)": ["int", "unsigned int", "int32_t", "uint32_t", "u32", "i32"],
  "Integer (long)": [
    "long",
    "unsigned long",
    "long long",
    "unsigned long long",
    "int64_t",
    "uint64_t",
    "u64",
    "i64",
  ],
  "Floating point": ["float", "f32", "float32", "double", "f64", "float64", "long double"],
  "Pointer/address": ["size_t", "ssize_t", "intptr_t", "uintptr_t", "ptrdiff_t"],
  "Boolean/enum": ["bool", "_Bool", "enum"],
};

function readReferenceModel(spec: LayoutSpec): DataModel {
  const v = readString(spec.options, OPTION_REFERENCE_MODEL, "LP64");
  return v in dataModels ? (v as DataModel) : "LP64";
}

export function computeDataModels(spec: LayoutSpec): ToolResult {
  const modelId = readReferenceModel(spec);
  const model = dataModels[modelId];
  const typeMap = getStandardTypeMap(modelId);

  const modelsTable: ToolTable = {
    id: "models",
    title: "Data models",
    summary: "Sizes in bytes. Alignment equals size unless an ABI override applies.",
    columns: [
      { key: "model", label: "Model", mono: true },
      { key: "short", label: "short", align: "right", mono: true },
      { key: "int", label: "int", align: "right", mono: true },
      { key: "long", label: "long", align: "right", mono: true },
      { key: "longLong", label: "long long", align: "right", mono: true },
      { key: "pointer", label: "pointer", align: "right", mono: true },
      { key: "float", label: "float", align: "right", mono: true },
      { key: "double", label: "double", align: "right", mono: true },
      { key: "enum", label: "enum", align: "right", mono: true },
    ],
    rows: dataModelList.map((m) => ({
      model: m.displayName,
      short: m.dataTypes.shortSize,
      int: m.dataTypes.intSize,
      long: m.dataTypes.longSize,
      longLong: m.dataTypes.longLongSize,
      pointer: m.dataTypes.pointerSize,
      float: m.dataTypes.floatSize,
      double: m.dataTypes.doubleSize,
      enum: m.dataTypes.enumSize,
    })),
  };

  const typesTable: ToolTable = {
    id: "types",
    title: `${model.displayName} primitive types`,
    summary: model.description,
    columns: [
      { key: "category", label: "Category" },
      { key: "type", label: "Type", mono: true },
      { key: "size", label: "Size", align: "right", mono: true },
      { key: "alignment", label: "Align", align: "right", mono: true },
    ],
    rows: Object.entries(TYPE_CATEGORIES).flatMap(([category, types]) =>
      types
        .filter((t) => typeMap[t])
        .map((t) => ({
          category,
          type: t,
          size: typeMap[t]!.size,
          alignment: typeMap[t]!.alignment,
        })),
    ),
  };

  const targetsTable: ToolTable = {
    id: "targets",
    title: "Targets",
    summary: "Data models and operating systems each target supports in the calculator.",
    columns: [
      { key: "target", label: "Architecture" },
      { key: "models", label: "Data models", mono: true },
      { key: "os", label: "OS" },
    ],
    rows: targetArchitectureList.map((t) => ({
      target: t.displayName,
      models: getValidDataModelsForArchitecture(t.id).join(", "),
      os: t.supportedOSTypes.map((o) => osTypes[o]?.displayName ?? o).join(", "),
    })),
  };

  return { tables: [typesTable, modelsTable, targetsTable] };
}
