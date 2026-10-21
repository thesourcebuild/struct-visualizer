import { createOptionCatalogue } from "@sp/engine";
import type { OptionCatalogue, OptionDef } from "@sp/engine";
import { RUST_TARGETS } from "@sp/core";
import {
  OPTION_COMPARE,
  OPTION_EXPLAIN,
  OPTION_MODE,
  OPTION_RUST_TARGET,
  TAG_OPTIMIZED,
  TAG_REORDERABLE,
  TOOL_RUST_STRUCT_LAYOUT,
  TOOL_RUST_VERIFICATION_CODE,
} from "../pure";
import type { RustGroup } from "./groups";

const TARGET: OptionDef<RustGroup> = {
  id: OPTION_RUST_TARGET,
  label: "Target",
  group: "platform",
  kind: "enum",
  choices: RUST_TARGETS.map((t) => ({ value: t.id, label: t.label, summary: `${t.id}: ${t.description}` })),
  summary: "Target triple: pointer size and the alignment of 64- and 128-bit values.",
  order: 0,
  colSpan: 2,
};

const MODE: OptionDef<RustGroup> = {
  id: OPTION_MODE,
  label: "Field order",
  group: "layout",
  kind: "enum",
  choices: [
    { value: "natural", label: "As declared", summary: "repr(C) keeps the declaration order." },
    { value: "optimized", label: "Optimized", summary: "The order rustc would choose, which keeps repr(C) but drops the padding." },
  ],
  summary: "Only repr(C) structs keep their declared order; rustc already reorders everything else.",
  availableOn: [TAG_REORDERABLE],
  order: 0,
  colSpan: 2,
};

const COMPARE: OptionDef<RustGroup> = {
  id: OPTION_COMPARE,
  label: "Compare with original",
  group: "layout",
  kind: "boolean",
  summary: "Show the declared and optimized layouts side by side.",
  availableOn: [TAG_OPTIMIZED],
  order: 1,
};

const EXPLAIN: OptionDef<RustGroup> = {
  id: OPTION_EXPLAIN,
  label: "Explain mode",
  group: "layout",
  kind: "boolean",
  summary: "Show the padding equation for every field in the step-by-step breakdown.",
  order: 2,
};

const CATALOGUES: Record<string, readonly OptionDef<RustGroup>[]> = {
  [TOOL_RUST_STRUCT_LAYOUT]: [TARGET, MODE, COMPARE, EXPLAIN],
  [TOOL_RUST_VERIFICATION_CODE]: [MODE, TARGET],
};

export function rustCatalogueFor(toolId: string): OptionCatalogue<RustGroup> {
  return createOptionCatalogue(CATALOGUES[toolId] ?? []);
}
