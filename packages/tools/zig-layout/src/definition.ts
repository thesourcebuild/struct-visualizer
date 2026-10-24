import type { OptionValue } from "@sp/contracts";
import type { ToolDefinition, ToolManifest, ToolResultField, ToolSample } from "@sp/engine";
import { analyzeZig, getZigTarget, zigBackend, zigExamples, zigFloatLayout, zigIntAlignment, zigPointerBits } from "@sp/core";
import { OPTION_GROUP_META } from "./catalogue/groups";
import { zigCatalogueFor } from "./catalogue/options";
import { requireZigTool } from "./catalogue/tool-meta";
import { computeZigLayout, computeZigVerificationCode } from "./compute";
import type { ZigLayoutData } from "./compute";
import { createSpec, normalizeOptions, readZigTarget } from "./create-spec";
import { ZIG_LAYOUT_RULES, ZIG_VERIFICATION_RULES } from "./lint/rules";
import { ZIG_MANIFESTS } from "./manifest";
import { TAG_OPTIMIZED, TAG_REORDERABLE, TOOL_ZIG_STRUCT_LAYOUT, TOOL_ZIG_VERIFICATION_CODE, readBuildMode, readMode } from "./pure";
import { ZigLayoutSpec } from "./spec";
import { zigLayoutVariants } from "./variants";

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const SAMPLES: readonly ToolSample[] = zigExamples.map((e) => ({ id: slug(e.name), label: e.name, input: e.code }));

function requireManifest(toolId: string): ToolManifest {
  requireZigTool(toolId);
  return ZIG_MANIFESTS.find((m) => m.id === toolId)!;
}

/** Field order only matters for an extern struct: Zig already orders plain ones. */
function variantTags(spec: ZigLayoutSpec, input: string): string[] {
  const tags: string[] = [];
  const def = analyzeZig(input, readZigTarget(spec.options), readBuildMode(spec.options)).definition;
  if (def?.kind === "struct" && def.layout === "extern") {
    tags.push(TAG_REORDERABLE);
    if (readMode(spec.options) === "optimized") tags.push(TAG_OPTIMIZED);
  }
  return tags;
}

function targetInfo(spec: ZigLayoutSpec): ToolResultField[] {
  const t = getZigTarget(readZigTarget(spec.options));
  const bytes = zigPointerBits(t) / 8;
  const mode = readBuildMode(spec.options);
  return [
    { label: "-target", value: `${t.id}${t.cpu ? ` -mcpu=${t.cpu}` : ""}`, mono: true },
    { label: "usize, pointers", value: `${bytes} bytes`, mono: true },
    { label: "[]T slices", value: `${2 * bytes} bytes`, mono: true },
    { label: "u64 / f64 alignment", value: `${zigIntAlignment(t, 64)} / ${zigFloatLayout(t, 64).align} bytes`, mono: true },
    { label: "u128 alignment", value: `${zigIntAlignment(t, 128)} bytes`, mono: true },
    { label: "Code generator", value: zigBackend(t, mode) === "x86_64" ? "Zig's x86-64 backend" : "LLVM", mono: true },
  ];
}

export function zigToolDefinition(toolId: string): ToolDefinition<ZigLayoutSpec, ZigLayoutData> {
  const manifest = requireManifest(toolId);
  const base = {
    ...manifest,
    groups: OPTION_GROUP_META,
    catalogue: zigCatalogueFor(toolId),
    createSpec,
    specSchema: ZigLayoutSpec,
    samples: SAMPLES,
    variantTag: variantTags,
    onOptionChange: (spec: ZigLayoutSpec, id: string, value: OptionValue): ZigLayoutSpec => ({
      ...spec,
      options: normalizeOptions({ ...spec.options, [id]: value }),
    }),
  };
  const targetPhrase = (spec: ZigLayoutSpec) => `${getZigTarget(readZigTarget(spec.options)).id} (${readBuildMode(spec.options)})`;

  switch (toolId) {
    case TOOL_ZIG_STRUCT_LAYOUT:
      return {
        ...base,
        lintRules: ZIG_LAYOUT_RULES,
        describe: (spec) => `Memory layout on ${targetPhrase(spec)}, as Zig 0.16 lays it out.`,
        info: targetInfo,
        compute: computeZigLayout,
        variants: zigLayoutVariants,
      };
    case TOOL_ZIG_VERIFICATION_CODE:
      return {
        ...base,
        lintRules: ZIG_VERIFICATION_RULES,
        describe: (spec) => `Zig program printing @sizeOf, @alignOf and @offsetOf to compare with ${targetPhrase(spec)}.`,
        compute: computeZigVerificationCode,
      };
    default:
      throw new Error(`Unknown Zig tool: ${toolId}`);
  }
}
