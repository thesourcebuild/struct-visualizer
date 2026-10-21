import type { OptionValue } from "@sp/contracts";
import type { ToolDefinition, ToolManifest, ToolResultField, ToolSample } from "@sp/engine";
import { getRustTarget, parseRust, rustExamples } from "@sp/core";
import { OPTION_GROUP_META } from "./catalogue/groups";
import { rustCatalogueFor } from "./catalogue/options";
import { requireRustTool } from "./catalogue/tool-meta";
import { computeRustLayout, computeRustVerificationCode } from "./compute";
import type { RustLayoutData } from "./compute";
import { createSpec, normalizeOptions, readRustTarget } from "./create-spec";
import { RUST_LAYOUT_RULES, RUST_VERIFICATION_RULES } from "./lint/rules";
import { RUST_MANIFESTS } from "./manifest";
import { TAG_OPTIMIZED, TAG_REORDERABLE, TOOL_RUST_STRUCT_LAYOUT, TOOL_RUST_VERIFICATION_CODE, readMode } from "./pure";
import { RustLayoutSpec } from "./spec";
import { rustLayoutVariants } from "./variants";

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const SAMPLES: readonly ToolSample[] = rustExamples.map((e) => ({ id: slug(e.name), label: e.name, input: e.code }));

function requireManifest(toolId: string): ToolManifest {
  requireRustTool(toolId);
  return RUST_MANIFESTS.find((m) => m.id === toolId)!;
}

/** Field order only matters for a repr(C) struct: rustc already orders everything else. */
function variantTags(spec: RustLayoutSpec, input: string): string[] {
  const tags: string[] = [];
  const file = parseRust(input);
  const last = [...file.order].reverse().map((n) => file.items.get(n)!).find((i) => i.kind !== "alias" && i.generics.length === 0);
  if (last?.kind === "struct" && last.repr.c) {
    tags.push(TAG_REORDERABLE);
    if (readMode(spec.options) === "optimized") tags.push(TAG_OPTIMIZED);
  }
  return tags;
}

function targetInfo(spec: RustLayoutSpec): ToolResultField[] {
  const t = getRustTarget(readRustTarget(spec.options));
  return [
    { label: "Triple", value: t.id, mono: true },
    { label: "usize, isize, pointers", value: `${t.pointerBytes} bytes`, mono: true },
    { label: "&[T], &str, Box<dyn Trait>", value: `${2 * t.pointerBytes} bytes`, mono: true },
    { label: "u64 / f64 alignment", value: `${t.align.i64} / ${t.align.f64} bytes`, mono: true },
    { label: "u128 alignment", value: `${t.align.i128} bytes`, mono: true },
  ];
}

export function rustToolDefinition(toolId: string): ToolDefinition<RustLayoutSpec, RustLayoutData> {
  const manifest = requireManifest(toolId);
  const base = {
    ...manifest,
    groups: OPTION_GROUP_META,
    catalogue: rustCatalogueFor(toolId),
    createSpec,
    specSchema: RustLayoutSpec,
    samples: SAMPLES,
    variantTag: variantTags,
    onOptionChange: (spec: RustLayoutSpec, id: string, value: OptionValue): RustLayoutSpec => ({
      ...spec,
      options: normalizeOptions({ ...spec.options, [id]: value }),
    }),
  };
  const targetPhrase = (spec: RustLayoutSpec) => getRustTarget(readRustTarget(spec.options)).id;

  switch (toolId) {
    case TOOL_RUST_STRUCT_LAYOUT:
      return {
        ...base,
        lintRules: RUST_LAYOUT_RULES,
        describe: (spec) => `Memory layout on ${targetPhrase(spec)}, as rustc lays it out.`,
        info: targetInfo,
        compute: computeRustLayout,
        variants: rustLayoutVariants,
      };
    case TOOL_RUST_VERIFICATION_CODE:
      return {
        ...base,
        lintRules: RUST_VERIFICATION_RULES,
        describe: (spec) => `Rust program printing size_of, align_of and offset_of! to compare with ${targetPhrase(spec)}.`,
        compute: computeRustVerificationCode,
      };
    default:
      throw new Error(`Unknown Rust tool: ${toolId}`);
  }
}
