import { createOptionCatalogue } from "@sp/engine";
import type { OptionCatalogue, OptionDef } from "@sp/engine";
import { ZIG_TARGETS, ZIG_X86_64_CPUS } from "@sp/core";
import {
  OPTION_BUILD_MODE,
  OPTION_COMPARE,
  OPTION_ERROR_LIMIT,
  OPTION_EXPLAIN,
  OPTION_MODE,
  OPTION_ZIG_CPU,
  OPTION_ZIG_TARGET,
  TAG_OPTIMIZED,
  TAG_REORDERABLE,
  TAG_X86_64,
  TOOL_ZIG_STRUCT_LAYOUT,
  TOOL_ZIG_VERIFICATION_CODE,
} from "../pure";
import type { ZigGroup } from "./groups";

const TARGET: OptionDef<ZigGroup> = {
  id: OPTION_ZIG_TARGET,
  label: "Target",
  group: "platform",
  kind: "enum",
  choices: ZIG_TARGETS.map((t) => ({ value: t.id, label: t.label, summary: `${t.id}${t.cpu ? ` -mcpu=${t.cpu}` : ""}: ${t.description}` })),
  summary: "What -target takes: pointer size and the alignment of integers, floats and C types.",
  order: 0,
  colSpan: 2,
};

const BUILD_MODE: OptionDef<ZigGroup> = {
  id: OPTION_BUILD_MODE,
  label: "Build mode",
  group: "platform",
  kind: "enum",
  choices: [
    { value: "Debug", label: "Debug", summary: "Safety checks on: bare unions carry a hidden tag. On x86-64 Linux, Zig's own code generator lays out vectors." },
    { value: "ReleaseSafe", label: "ReleaseSafe", summary: "Safety checks on: bare unions carry a hidden tag." },
    { value: "ReleaseFast", label: "ReleaseFast", summary: "No safety checks: bare unions are only their largest field." },
    { value: "ReleaseSmall", label: "ReleaseSmall", summary: "No safety checks: bare unions are only their largest field." },
  ],
  summary: "-O: whether bare unions (and std types holding a SafetyLock) carry safety state.",
  order: 1,
  colSpan: 2,
};

const ERROR_LIMIT: OptionDef<ZigGroup> = {
  id: OPTION_ERROR_LIMIT,
  label: "Error limit",
  group: "platform",
  kind: "number",
  arg: { min: 0, max: 4294967295, step: 1 },
  summary: "--error-limit: how many error names the program may have. Error codes take log2 of it plus one bits: u16 by default (65535), u8 for 255.",
  order: 3,
  colSpan: 2,
};

const CPU: OptionDef<ZigGroup> = {
  id: OPTION_ZIG_CPU,
  label: "CPU",
  group: "platform",
  kind: "enum",
  choices: ZIG_X86_64_CPUS.map((c) => ({
    value: c.id,
    label: c.label,
    summary: c.id === "x86_64" ? "What -target builds for without -mcpu." : `-mcpu=${c.id}${c.avx512f ? ": AVX-512F" : c.avx ? ": AVX" : ""}.`,
  })),
  summary: "-mcpu: in Debug on x86-64 Linux, Zig's own code generator aligns vectors over 16 bytes to 32 with AVX and 64 with AVX-512F.",
  availableOn: [TAG_X86_64],
  order: 2,
  colSpan: 2,
};

const MODE: OptionDef<ZigGroup> = {
  id: OPTION_MODE,
  label: "Field order",
  group: "layout",
  kind: "enum",
  choices: [
    { value: "natural", label: "As declared", summary: "An extern struct keeps the declaration order." },
    { value: "optimized", label: "Optimized", summary: "The order Zig gives a plain struct, which keeps extern but drops the padding." },
  ],
  summary: "Only extern structs keep their declared order; Zig already orders plain structs.",
  availableOn: [TAG_REORDERABLE],
  order: 0,
  colSpan: 2,
};

const COMPARE: OptionDef<ZigGroup> = {
  id: OPTION_COMPARE,
  label: "Compare with original",
  group: "layout",
  kind: "boolean",
  summary: "Show the declared and optimized layouts side by side.",
  availableOn: [TAG_OPTIMIZED],
  order: 1,
};

const EXPLAIN: OptionDef<ZigGroup> = {
  id: OPTION_EXPLAIN,
  label: "Explain mode",
  group: "layout",
  kind: "boolean",
  summary: "Show the padding equation for every field in the step-by-step breakdown.",
  order: 2,
};

const CATALOGUES: Record<string, readonly OptionDef<ZigGroup>[]> = {
  [TOOL_ZIG_STRUCT_LAYOUT]: [TARGET, BUILD_MODE, CPU, ERROR_LIMIT, MODE, COMPARE, EXPLAIN],
  [TOOL_ZIG_VERIFICATION_CODE]: [MODE, TARGET, BUILD_MODE, CPU, ERROR_LIMIT],
};

export function zigCatalogueFor(toolId: string): OptionCatalogue<ZigGroup> {
  return createOptionCatalogue(CATALOGUES[toolId] ?? []);
}
