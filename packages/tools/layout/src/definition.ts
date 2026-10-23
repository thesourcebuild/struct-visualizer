import type { OptionValue } from "@sp/contracts";
import type { ToolDefinition, ToolManifest, ToolResultField } from "@sp/engine";
import {
  getSupportedOSTypes,
  getValidDataModelsForArchitecture,
  dataModels,
  osTypes,
  packingSyntaxes,
  packingSyntaxesFor,
  StructParser,
} from "@sp/core";
import { OPTION_GROUP_META } from "./catalogue/groups";
import { layoutCatalogueFor } from "./catalogue/options";
import { requireLayoutTool } from "./catalogue/tool-meta";
import { computeDataModels } from "./reference";
import { computeLayout, computeVerificationCode } from "./compute";
import { resolveSpec } from "./resolve";
import type { LayoutData } from "./compute";
import { createSpec, normalizeOptions, readTarget } from "./create-spec";
import { describeDataModels, describeLayout, describeVerification } from "./explain/describe";
import { LAYOUT_RULES, VERIFICATION_RULES } from "./lint/rules";
import { LAYOUT_MANIFESTS } from "./manifest";
import {
  OPTION_DATA_MODEL,
  OPTION_ENUM_ALIGN,
  OPTION_ENUM_SIZE,
  OPTION_OS,
  OPTION_PACKING,
  TAG_HAS_ENUM,
  TAG_OPTIMIZED,
  TAG_OS_SELECTABLE,
  TAG_PACKED,
  TOOL_DATA_MODELS,
  TOOL_STRUCT_LAYOUT,
  TOOL_VERIFICATION_CODE,
  readMode,
} from "./pure";
import { layoutSamples } from "./samples";
import { LayoutSpec } from "./spec";
import { layoutVariants } from "./variants";

function requireManifest(toolId: string): ToolManifest {
  requireLayoutTool(toolId);
  return LAYOUT_MANIFESTS.find((m) => m.id === toolId)!;
}

function variantTags(spec: LayoutSpec, input: string): string[] {
  const tags: string[] = [];
  const target = readTarget(spec.options);
  const os = getSupportedOSTypes(target);
  if (os.length > 1 || os[0] !== "none") tags.push(TAG_OS_SELECTABLE);
  if (readMode(spec.options) === "optimized") tags.push(TAG_OPTIMIZED);
  if (readMode(spec.options) === "packed") tags.push(TAG_PACKED);
  // Cheap: parse only to see whether any enum is declared.
  if (/\benum\b/.test(input)) {
    const parser = new StructParser(resolveSpec(spec));
    parser.parse(input);
    if (parser.getAllEnums().length > 0) tags.push(TAG_HAS_ENUM);
  }
  return tags;
}

function choicesFor(spec: LayoutSpec, optionId: string) {
  const target = readTarget(spec.options);
  if (optionId === OPTION_DATA_MODEL) {
    return getValidDataModelsForArchitecture(target).map((id) => ({
      value: id,
      label: dataModels[id]?.displayName ?? id,
    }));
  }
  if (optionId === OPTION_OS) {
    return getSupportedOSTypes(target).map((id) => ({
      value: id,
      label: osTypes[id]?.displayName ?? id,
    }));
  }
  if (optionId === OPTION_PACKING) {
    // Only what the platform's compiler accepts: #pragma pack alone for MSVC and the 8051.
    const platform = resolveSpec(spec);
    return packingSyntaxesFor(platform.os, platform.dataModel).map((id) => ({
      value: id,
      label: packingSyntaxes[id].code,
      summary: `Accepted by ${packingSyntaxes[id].compilers}`,
    }));
  }
  if (optionId === OPTION_ENUM_SIZE || optionId === OPTION_ENUM_ALIGN) {
    // Show what "default" means for the selected data model, so no separate note is needed.
    const n = resolveSpec(spec).defaultEnumSize;
    return [
      { value: "default", label: `Data model default (${n} ${n === 1 ? "byte" : "bytes"})` },
      ...[1, 2, 4, 8].map((v) => ({ value: String(v), label: `${v} ${v === 1 ? "byte" : "bytes"}` })),
    ];
  }
  return undefined;
}

function onOptionChange(spec: LayoutSpec, id: string, value: OptionValue): LayoutSpec {
  return { ...spec, options: normalizeOptions({ ...spec.options, [id]: value }) };
}

function platformInfo(spec: LayoutSpec): ToolResultField[] {
  const p = resolveSpec(spec);
  const a = p.architecture;
  return [
    { label: "Base ABI", value: a.displayName },
    { label: "Pointer size", value: `${a.pointerSize} bytes`, mono: true },
    { label: "Default alignment", value: `${a.defaultAlignment} bytes`, mono: true },
    { label: "Max alignment", value: `${a.maxAlignment ?? a.defaultAlignment} bytes`, mono: true },
    {
      label: "Struct alignment rule",
      value:
        typeof a.packingRules.structAlignment === "number"
          ? `fixed ${a.packingRules.structAlignment}`
          : a.packingRules.structAlignment === "max"
            ? "largest member (capped)"
            : "target default",
    },
    { label: "Enum default", value: `${p.defaultEnumSize} bytes`, mono: true },
  ];
}

export function layoutToolDefinition(toolId: string): ToolDefinition<LayoutSpec, LayoutData> {
  const manifest = requireManifest(toolId);
  const base = {
    ...manifest,
    groups: OPTION_GROUP_META,
    catalogue: layoutCatalogueFor(toolId),
    createSpec,
    specSchema: LayoutSpec,
    choicesFor,
    onOptionChange,
  };

  switch (toolId) {
    case TOOL_STRUCT_LAYOUT:
      return {
        ...base,
        lintRules: LAYOUT_RULES,
        describe: describeLayout,
        info: platformInfo,
        samples: layoutSamples("c"),
        compute: computeLayout,
        variants: layoutVariants,
        variantTag: variantTags,
      };
    case TOOL_VERIFICATION_CODE:
      return {
        ...base,
        lintRules: VERIFICATION_RULES,
        describe: describeVerification,
        samples: layoutSamples("c"),
        compute: computeVerificationCode,
        variantTag: variantTags,
      };
    case TOOL_DATA_MODELS:
      return {
        ...base,
        lintRules: [],
        describe: describeDataModels,
        compute: (spec) => computeDataModels(spec) as ReturnType<typeof computeLayout>,
      };
    default:
      throw new Error(`Unknown layout tool: ${toolId}`);
  }
}
