import { createOptionCatalogue } from "@sp/engine";
import type { OptionCatalogue, OptionDef } from "@sp/engine";
import { dataModelList, osTypeList, packingSyntaxes, targetArchitectureList } from "@sp/core";
import {
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
  TAG_HAS_ENUM,
  TAG_OPTIMIZED,
  TAG_OS_SELECTABLE,
  TAG_PACKED,
  TOOL_DATA_MODELS,
  TOOL_STRUCT_LAYOUT,
  TOOL_VERIFICATION_CODE,
} from "../pure";
import type { LayoutGroup } from "./groups";

const ENUM_OVERRIDE_CHOICES = [
  { value: "default", label: "Data model default" },
  { value: "1", label: "1 byte" },
  { value: "2", label: "2 bytes" },
  { value: "4", label: "4 bytes" },
  { value: "8", label: "8 bytes" },
] as const;

const TARGET: OptionDef<LayoutGroup> = {
  id: OPTION_TARGET,
  label: "Architecture",
  group: "platform",
  kind: "enum",
  choices: targetArchitectureList.map((t) => ({
    value: t.id,
    label: t.displayName,
    summary: t.description,
  })),
  summary: "CPU family; decides pointer size and the alignment caps.",
  order: 0,
  colSpan: 2,
};

const DATA_MODEL: OptionDef<LayoutGroup> = {
  id: OPTION_DATA_MODEL,
  label: "Data model",
  group: "platform",
  kind: "enum",
  choices: dataModelList.map((m) => ({ value: m.id, label: m.displayName, summary: m.description })),
  summary: "Sizes of int/long/pointer (LP64, LLP64, ILP32, ...). Limited to models valid for the target.",
  order: 1,
};

const OS: OptionDef<LayoutGroup> = {
  id: OPTION_OS,
  label: "Operating system",
  group: "platform",
  kind: "enum",
  choices: osTypeList.map((o) => ({ value: o.id, label: o.displayName, summary: o.description })),
  summary: "Windows and Linux ABIs differ for 64-bit scalars and long double on x86.",
  availableOn: [TAG_OS_SELECTABLE],
  order: 2,
};

const MODE: OptionDef<LayoutGroup> = {
  id: OPTION_MODE,
  label: "Layout mode",
  group: "layout",
  kind: "enum",
  choices: [
    { value: "natural", label: "Natural", summary: "Default compiler alignment." },
    { value: "packed", label: "Packed", summary: "Every struct packed, in the syntax chosen below: no padding." },
    { value: "optimized", label: "Optimized", summary: "Members reordered to minimise padding." },
  ],
  summary: "Which layout to display.",
  order: 0,
  colSpan: 2,
};

const PACKING: OptionDef<LayoutGroup> = {
  id: OPTION_PACKING,
  label: "Packing syntax",
  group: "layout",
  kind: "enum",
  // Narrowed per platform by choicesFor: MSVC and the 8051 compilers accept only #pragma pack.
  choices: Object.values(packingSyntaxes).map((s) => ({ value: s.id, label: s.code, summary: `Accepted by ${s.compilers}` })),
  summary: "How the packing is written. Compilers accept different ones, and they differ for zero-width bit-fields.",
  availableOn: [TAG_PACKED],
  order: 1,
  colSpan: 2,
  control: "select",
};

const COMPARE: OptionDef<LayoutGroup> = {
  id: OPTION_COMPARE,
  label: "Compare with original",
  group: "layout",
  kind: "boolean",
  summary: "Show the original and optimized layouts side by side.",
  availableOn: [TAG_OPTIMIZED],
  order: 1,
};

const EXPLAIN: OptionDef<LayoutGroup> = {
  id: OPTION_EXPLAIN,
  label: "Explain mode",
  group: "layout",
  kind: "boolean",
  summary: "Show the padding equation for every member in the step-by-step breakdown.",
  order: 2,
};

const ENUM_SIZE: OptionDef<LayoutGroup> = {
  id: OPTION_ENUM_SIZE,
  label: "Enum size",
  group: "enum",
  kind: "enum",
  choices: ENUM_OVERRIDE_CHOICES,
  summary: "Storage size for enums without an explicit underlying type.",
  availableOn: [TAG_HAS_ENUM],
  order: 0,
};

const ENUM_ALIGN: OptionDef<LayoutGroup> = {
  id: OPTION_ENUM_ALIGN,
  label: "Enum alignment",
  group: "enum",
  kind: "enum",
  choices: ENUM_OVERRIDE_CHOICES,
  summary: "Alignment for enums without an explicit underlying type.",
  availableOn: [TAG_HAS_ENUM],
  order: 1,
};

const LANGUAGE: OptionDef<LayoutGroup> = {
  id: OPTION_LANGUAGE,
  label: "Language",
  group: "platform",
  kind: "enum",
  choices: [
    { value: "c", label: "C", summary: "Struct layout as a C compiler does it." },
    { value: "c++17", label: "C++17", summary: "C++11 to C++17: base classes, virtual functions and virtual bases laid out by the target's C++ ABI (Itanium or MSVC)." },
    { value: "c++20", label: "C++20", summary: "C++20 and later: as C++17, except that a class whose constructors are all defaulted or deleted lets a derived class reuse its tail padding (Itanium ABI)." },
  ],
  summary: "The language the source is compiled as, and the generated program is written in.",
  order: -1,
};

// The same three modes, with the same labels, as the Struct Layout tool.
const VERIFY_MODE: OptionDef<LayoutGroup> = {
  ...MODE,
  summary: "Verify the struct as written, packed in the syntax chosen below, or reordered.",
};

const REFERENCE_MODEL: OptionDef<LayoutGroup> = {
  ...DATA_MODEL,
  id: OPTION_REFERENCE_MODEL,
  summary: "Show the full primitive type table for this data model.",
  colSpan: 2,
};

const CATALOGUES: Record<string, readonly OptionDef<LayoutGroup>[]> = {
  [TOOL_STRUCT_LAYOUT]: [LANGUAGE, TARGET, DATA_MODEL, OS, MODE, PACKING, COMPARE, EXPLAIN, ENUM_SIZE, ENUM_ALIGN],
  [TOOL_VERIFICATION_CODE]: [LANGUAGE, VERIFY_MODE, PACKING, TARGET, DATA_MODEL, OS, ENUM_SIZE, ENUM_ALIGN],
  [TOOL_DATA_MODELS]: [REFERENCE_MODEL],
};

export function layoutCatalogueFor(toolId: string): OptionCatalogue<LayoutGroup> {
  return createOptionCatalogue(CATALOGUES[toolId] ?? []);
}
