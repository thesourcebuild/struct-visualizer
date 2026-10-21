import type { Diagnostic, LintRule } from "@sp/contracts";
import type { LintContext } from "@sp/engine";
import { analyzeStruct, bitfieldVerification, getSupportedOSTypes, osTypes } from "@sp/core";
import type { CalculationResult, StructAnalysis, StructMember } from "@sp/core";
import type { LayoutData } from "../compute";
import { OPTION_MODE, OPTION_OS, withOption } from "../pure";
import type { LayoutMode } from "../pure";
import { selectionFromSpec } from "../resolve";
import type { LayoutSpec } from "../spec";

type Ctx = LintContext<LayoutSpec, LayoutData>;
type Rule = LintRule<Ctx, LayoutSpec>;
type Diag = Diagnostic<LayoutSpec>;

function layoutFor(analysis: StructAnalysis, mode: LayoutMode): CalculationResult | null {
  return mode === "packed" ? analysis.packed : mode === "optimized" ? analysis.optimized : analysis.result;
}

function walkMembers(members: readonly StructMember[], visit: (m: StructMember) => void): void {
  for (const m of members) {
    visit(m);
    if (m.nestedStruct) walkMembers(m.nestedStruct.members, visit);
  }
}

/** SP000 — parse and type-validation errors. */
const parseErrors: Rule = {
  code: "SP000",
  check: ({ result }) =>
    (result.data?.analysis.errors ?? []).map(
      (e): Diag => ({ code: "SP000", level: "error", message: e.message, line: e.line }),
    ),
};

/** SP001 — reordering members would remove padding. */
const reorderablePadding: Rule = {
  code: "SP001",
  check: ({ result }) => {
    const data = result.data;
    const current = data?.analysis.result;
    const optimized = data?.analysis.optimized;
    if (!data || !current || !optimized || data.mode !== "natural") return [];
    const saved = current.totalSize - optimized.totalSize;
    if (saved <= 0) return [];
    const pct = ((saved / current.totalSize) * 100).toFixed(1);
    return [
      {
        code: "SP001",
        level: "warning",
        message: `Reordering members saves ${saved} byte${saved === 1 ? "" : "s"} (${pct}%).`,
        detail: `${current.totalSize} → ${optimized.totalSize} bytes by sorting members by alignment, then size.`,
        optionIds: [OPTION_MODE],
        fix: {
          label: "Show optimized layout",
          apply: (spec) => withOption(spec, OPTION_MODE, "optimized"),
        },
      },
    ];
  },
};

/** SP003 — a type fell back to the 4-byte default. */
const unknownTypes: Rule = {
  code: "SP003",
  check: ({ result }) =>
    (result.data?.analysis.unknownTypes ?? []).map(
      (t): Diag => ({
        code: "SP003",
        level: "error",
        message: `Unknown type '${t}' was sized as 4 bytes / align 4.`,
        detail: "The result for members of this type is a guess.",
      }),
    ),
};

/**
 * SP004 — the bit-fields are laid out by rules not checked against this target's compiler. Every
 * other target's rules are checked bit by bit in tests/cross-compiler.test.ts.
 */
const bitfieldUnverified: Rule = {
  code: "SP004",
  check: ({ result }) => {
    const analysis = result.data?.analysis;
    const def = analysis?.definition;
    if (!analysis || !def) return [];
    let hasBitfield = false;
    walkMembers(def.members, (m) => {
      if (m.bitField !== undefined) hasBitfield = true;
    });
    if (!hasBitfield) return [];
    const { dataModel, target, os } = analysis.platform;
    const check = bitfieldVerification(dataModel, target, os);
    if (check.verified) return [];
    return [
      {
        code: "SP004",
        level: "warning",
        message: `Bit-field positions here are not checked against ${check.compiler}.`,
        detail:
          "They follow GCC's rules for this kind of target. Run the Verification Code tool with your compiler to confirm them.",
      },
    ];
  },
};

/**
 * SP005 — the same struct lays out differently on another OS of this target (e.g. x86 Linux
 * aligns double to 4, Windows to 8). Computed, not guessed: it fires only when the other OS's
 * layout really differs, and says how.
 */
const osDifference: Rule = {
  code: "SP005",
  check: ({ spec, input, result }) => {
    const data = result.data;
    const here = data?.display;
    if (!data || !here) return [];
    const platform = data.analysis.platform;
    const out: Diag[] = [];
    for (const os of getSupportedOSTypes(platform.target)) {
      if (os === platform.os || os === "none") continue;
      const there = layoutFor(analyzeStruct(input, { ...selectionFromSpec(spec), os }), data.mode);
      if (!there) continue;
      const moved = here.members
        .filter((m, i) => there.members[i]?.offset !== m.offset)
        .map((m) => m.member.name || "(anonymous)");
      const alignHere = here.struct.alignment ?? 1;
      const alignThere = there.struct.alignment ?? 1;
      if (there.totalSize === here.totalSize && moved.length === 0 && alignHere === alignThere) continue;
      const osName = osTypes[os]?.displayName ?? os;
      const kind = here.struct.isUnion ? "union" : "struct";
      out.push({
        code: "SP005",
        level: "info",
        message:
          there.totalSize !== here.totalSize
            ? `On ${osName} this ${kind} is ${there.totalSize} bytes, not ${here.totalSize}.`
            : moved.length > 0
              ? `On ${osName} the size is the same but member offsets differ.`
              : `On ${osName} this ${kind} is ${alignThere}-byte aligned, not ${alignHere}, which changes its placement inside other structs and arrays.`,
        detail: moved.length > 0 ? `Members at a different offset there: ${moved.join(", ")}.` : undefined,
        optionIds: [OPTION_OS],
        fix: { label: `Show ${osName} layout`, apply: (s) => withOption(s, OPTION_OS, os) },
      });
    }
    return out;
  },
};

/**
 * SP006 — a definition is not part of what is shown. Only the last definition is laid out;
 * earlier ones used as nested members are part of it, so they are not worth a note.
 */
const unusedDefinitions: Rule = {
  code: "SP006",
  check: ({ result }) => {
    const a = result.data?.analysis;
    if (!a?.definition || a.unusedDefinitions.length === 0) return [];
    const names = a.unusedDefinitions.map((n) => `'${n}'`).join(", ");
    const one = a.unusedDefinitions.length === 1;
    return [
      {
        code: "SP006",
        level: "info",
        message: `${names} ${one ? "is" : "are"} not laid out: only the last definition ('${a.definition.name}') is shown.`,
        detail: `Move the definition you want to inspect to the end, or use it as a member of '${a.definition.name}'.`,
      },
    ];
  },
};

/** SP008 — parser and preprocessor warnings (ignored pragmas, unmodelled attributes, ...). */
const parserWarnings: Rule = {
  code: "SP008",
  check: ({ result }) =>
    (result.data?.analysis.warnings ?? []).map(
      (w): Diag => ({ code: "SP008", level: "warning", message: w.message, line: w.line }),
    ),
};

// SP002 (packing directive not applied) and SP007 (enum default size) are retired: packing
// pragmas and attributes are applied now, and the enum default is shown in the Enum settings.
export const LAYOUT_RULES: readonly Rule[] = [
  parseErrors,
  reorderablePadding,
  unknownTypes,
  bitfieldUnverified,
  osDifference,
  unusedDefinitions,
  parserWarnings,
];

/** Verification-code tool only cares about errors and the parser's own warnings. */
export const VERIFICATION_RULES: readonly Rule[] = [parseErrors, unknownTypes, parserWarnings];
