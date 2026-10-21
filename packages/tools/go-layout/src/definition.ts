import type { OptionValue } from "@sp/contracts";
import type { ToolDefinition, ToolManifest, ToolResultField, ToolSample } from "@sp/engine";
import { getGoTarget, goExamples } from "@sp/core";
import { OPTION_GROUP_META } from "./catalogue/groups";
import { goCatalogueFor } from "./catalogue/options";
import { requireGoTool } from "./catalogue/tool-meta";
import { computeGoLayout, computeGoVerificationCode } from "./compute";
import type { GoLayoutData } from "./compute";
import { createSpec, normalizeOptions, readGoTarget } from "./create-spec";
import { GO_LAYOUT_RULES, GO_VERIFICATION_RULES } from "./lint/rules";
import { GO_MANIFESTS } from "./manifest";
import { TAG_OPTIMIZED, TOOL_GO_STRUCT_LAYOUT, TOOL_GO_VERIFICATION_CODE, readMode } from "./pure";
import { GoLayoutSpec } from "./spec";
import { goLayoutVariants } from "./variants";

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const SAMPLES: readonly ToolSample[] = goExamples.map((e) => ({ id: slug(e.name), label: e.name, input: e.code }));

function requireManifest(toolId: string): ToolManifest {
  requireGoTool(toolId);
  return GO_MANIFESTS.find((m) => m.id === toolId)!;
}

function targetPhrase(spec: GoLayoutSpec): string {
  const t = getGoTarget(readGoTarget(spec.options));
  return t.compiler === "gc" ? `GOARCH=${t.id} (gc)` : `${t.label} (TinyGo)`;
}

function targetInfo(spec: GoLayoutSpec): ToolResultField[] {
  const t = getGoTarget(readGoTarget(spec.options));
  return [
    { label: "Compiler", value: t.compiler === "gc" ? "gc (the standard Go toolchain)" : "TinyGo" },
    { label: "int, uint, uintptr, pointers", value: `${t.wordSize} bytes`, mono: true },
    { label: "string / slice / interface", value: `${2 * t.wordSize} / ${3 * t.wordSize} / ${2 * t.wordSize} bytes`, mono: true },
    { label: "Max alignment", value: `${t.maxAlign} bytes`, mono: true },
  ];
}

export function goToolDefinition(toolId: string): ToolDefinition<GoLayoutSpec, GoLayoutData> {
  const manifest = requireManifest(toolId);
  const base = {
    ...manifest,
    groups: OPTION_GROUP_META,
    catalogue: goCatalogueFor(toolId),
    createSpec,
    specSchema: GoLayoutSpec,
    samples: SAMPLES,
    variantTag: (spec: GoLayoutSpec) => (readMode(spec.options) === "optimized" ? [TAG_OPTIMIZED] : []),
    onOptionChange: (spec: GoLayoutSpec, id: string, value: OptionValue): GoLayoutSpec => ({
      ...spec,
      options: normalizeOptions({ ...spec.options, [id]: value }),
    }),
  };

  switch (toolId) {
    case TOOL_GO_STRUCT_LAYOUT:
      return {
        ...base,
        lintRules: GO_LAYOUT_RULES,
        describe: (spec) =>
          `Memory layout on ${targetPhrase(spec)}, ${readMode(spec.options) === "optimized" ? "fields in the suggested order" : "fields as declared"}.`,
        info: targetInfo,
        compute: computeGoLayout,
        variants: goLayoutVariants,
      };
    case TOOL_GO_VERIFICATION_CODE:
      return {
        ...base,
        lintRules: GO_VERIFICATION_RULES,
        describe: (spec) =>
          `Go program printing unsafe.Sizeof/Offsetof for the ${readMode(spec.options) === "optimized" ? "reordered" : "declared"} struct; compare on ${targetPhrase(spec)}.`,
        compute: computeGoVerificationCode,
      };
    default:
      throw new Error(`Unknown Go tool: ${toolId}`);
  }
}
