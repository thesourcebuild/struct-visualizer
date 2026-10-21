import { createOptionCatalogue } from "@sp/engine";
import type { OptionCatalogue, OptionDef } from "@sp/engine";
import { GO_TARGETS } from "@sp/core";
import {
  OPTION_COMPARE,
  OPTION_EXPLAIN,
  OPTION_GO_TARGET,
  OPTION_MODE,
  TAG_OPTIMIZED,
  TOOL_GO_STRUCT_LAYOUT,
  TOOL_GO_VERIFICATION_CODE,
} from "../pure";
import type { GoGroup } from "./groups";

const TARGET: OptionDef<GoGroup> = {
  id: OPTION_GO_TARGET,
  label: "GOARCH",
  group: "platform",
  kind: "enum",
  choices: GO_TARGETS.map((t) => ({
    value: t.id,
    label: t.compiler === "gc" ? t.label : `${t.label} (TinyGo)`,
    summary: t.description,
  })),
  summary: "Target architecture. 32-bit targets have 4-byte words and align 64-bit values to 4.",
  order: 0,
  colSpan: 2,
};

const MODE: OptionDef<GoGroup> = {
  id: OPTION_MODE,
  label: "Field order",
  group: "layout",
  kind: "enum",
  choices: [
    { value: "natural", label: "As declared", summary: "Go never reorders fields." },
    {
      value: "optimized",
      label: "Optimized",
      summary: "The order golang.org/x/tools fieldalignment suggests: least padding, pointer fields first.",
    },
  ],
  summary: "Which field order to display.",
  order: 0,
  colSpan: 2,
};

const COMPARE: OptionDef<GoGroup> = {
  id: OPTION_COMPARE,
  label: "Compare with original",
  group: "layout",
  kind: "boolean",
  summary: "Show the declared and optimized layouts side by side.",
  availableOn: [TAG_OPTIMIZED],
  order: 1,
};

const EXPLAIN: OptionDef<GoGroup> = {
  id: OPTION_EXPLAIN,
  label: "Explain mode",
  group: "layout",
  kind: "boolean",
  summary: "Show the padding equation for every field in the step-by-step breakdown.",
  order: 2,
};

const VERIFY_MODE: OptionDef<GoGroup> = {
  ...MODE,
  summary: "Verify the struct as declared, or the reordered copy.",
};

const CATALOGUES: Record<string, readonly OptionDef<GoGroup>[]> = {
  [TOOL_GO_STRUCT_LAYOUT]: [TARGET, MODE, COMPARE, EXPLAIN],
  [TOOL_GO_VERIFICATION_CODE]: [VERIFY_MODE, TARGET],
};

export function goCatalogueFor(toolId: string): OptionCatalogue<GoGroup> {
  return createOptionCatalogue(CATALOGUES[toolId] ?? []);
}
