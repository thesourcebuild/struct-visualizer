import type { Diagnostic, LintRule } from "@sp/contracts";
import type { LintContext } from "@sp/engine";
import type { ZigLayoutData } from "../compute";
import { OPTION_BUILD_MODE, OPTION_MODE, withOption } from "../pure";
import type { ZigLayoutSpec } from "../spec";

type Ctx = LintContext<ZigLayoutSpec, ZigLayoutData>;
type Rule = LintRule<Ctx, ZigLayoutSpec>;
type Diag = Diagnostic<ZigLayoutSpec>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const names = (list: readonly string[]) => list.map((n) => `'${n}'`).join(", ");

/** ZG000: syntax errors. */
const syntaxErrors: Rule = {
  code: "ZG000",
  check: ({ result }) =>
    (result.data?.analysis.errors ?? [])
      .filter((e) => e.type === "syntax")
      .map((e): Diag => ({ code: "ZG000", level: "error", message: e.message, line: e.line })),
};

/** ZG004: what Zig would reject, or a type that has no layout. */
const typeErrors: Rule = {
  code: "ZG004",
  check: ({ result }) =>
    (result.data?.analysis.errors ?? [])
      .filter((e) => e.type !== "syntax")
      .map((e): Diag => ({ code: "ZG004", level: "error", message: e.message, line: e.line })),
};

/** ZG001: an extern struct keeps its declared order, and another order is smaller. */
const reorder: Rule = {
  code: "ZG001",
  check: ({ result }) => {
    const data = result.data;
    const a = data?.analysis;
    if (!data || !a?.result || !a.optimized || data.mode !== "natural") return [];
    const saved = a.result.totalSize - a.optimized.totalSize;
    return [
      {
        code: "ZG001",
        level: "warning",
        message: `extern struct keeps the declared order; reordering the fields saves ${plural(saved, "byte")}: ${a.result.totalSize} → ${a.optimized.totalSize}.`,
        detail: "The order Zig gives a plain struct is also a valid extern order. Change the declaration only if nothing on the C side depends on it.",
        line: a.definition?.line,
        optionIds: [OPTION_MODE],
        fix: { label: "Show optimized order", apply: (s: ZigLayoutSpec) => withOption(s, OPTION_MODE, "optimized") },
      },
    ];
  },
};

/** ZG002: a bare union carries a safety tag in this build mode. */
const safetyTag: Rule = {
  code: "ZG002",
  check: ({ result }) => {
    const a = result.data?.analysis;
    const tag = a?.unionTag;
    if (!a?.result || !tag || tag.kind !== "safety") return [];
    return [
      {
        code: "ZG002",
        level: "info",
        message: `In ${a.mode}, '${a.definition!.name}' carries a hidden ${tag.type} tag that checks which field is active: ${a.result.totalSize} bytes here, less in ReleaseFast and ReleaseSmall.`,
        detail: "Use extern union for a layout that never changes, or union(enum) to keep the tag in every build.",
        line: a.definition!.line,
        optionIds: [OPTION_BUILD_MODE],
        fix: { label: "Show ReleaseFast", apply: (s: ZigLayoutSpec) => withOption(s, OPTION_BUILD_MODE, "ReleaseFast") },
      },
    ];
  },
};

/** ZG005: comptime fields take no space. */
const comptimeFields: Rule = {
  code: "ZG005",
  check: ({ result }) => {
    const a = result.data?.analysis;
    if (!a?.definition || a.comptimeFields.length === 0) return [];
    return [
      {
        code: "ZG005",
        level: "info",
        message: `${names(a.comptimeFields)} ${a.comptimeFields.length === 1 ? "is a comptime field" : "are comptime fields"}: known at compile time, ${a.comptimeFields.length === 1 ? "it takes" : "they take"} no space.`,
        line: a.definition.line,
      },
    ];
  },
};

/** ZG006: declarations not used by the one laid out. */
const unusedTypes: Rule = {
  code: "ZG006",
  check: ({ result }) => {
    const a = result.data?.analysis;
    if (!a?.definition || a.unusedTypes.length === 0) return [];
    const one = a.unusedTypes.length === 1;
    return [
      {
        code: "ZG006",
        level: "info",
        message: `${names(a.unusedTypes)} ${one ? "is" : "are"} not laid out: only the last type declared ('${a.definition.name}') is shown.`,
        detail: `Move the declaration you want to inspect to the end, or use it in a field of '${a.definition.name}'.`,
      },
    ];
  },
};

/** ZG007: parser warnings. */
const parserWarnings: Rule = {
  code: "ZG007",
  check: ({ result }) =>
    (result.data?.analysis.warnings ?? []).map((w): Diag => ({ code: "ZG007", level: "warning", message: w.message, line: w.line })),
};

export const ZIG_LAYOUT_RULES: readonly Rule[] = [syntaxErrors, typeErrors, reorder, safetyTag, comptimeFields, unusedTypes, parserWarnings];

export const ZIG_VERIFICATION_RULES: readonly Rule[] = [syntaxErrors, typeErrors, parserWarnings];
