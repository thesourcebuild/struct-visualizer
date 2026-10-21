import type { Diagnostic, LintRule } from "@sp/contracts";
import type { LintContext } from "@sp/engine";
import { GO_TARGETS, analyzeGo } from "@sp/core";
import type { GoLayoutData } from "../compute";
import { OPTION_GO_TARGET, OPTION_MODE, withOption } from "../pure";
import type { GoLayoutSpec } from "../spec";

type Ctx = LintContext<GoLayoutSpec, GoLayoutData>;
type Rule = LintRule<Ctx, GoLayoutSpec>;
type Diag = Diagnostic<GoLayoutSpec>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** GO000 — syntax errors. */
const syntaxErrors: Rule = {
  code: "GO000",
  check: ({ result }) =>
    (result.data?.analysis.errors ?? [])
      .filter((e) => e.type === "syntax")
      .map((e): Diag => ({ code: "GO000", level: "error", message: e.message, line: e.line })),
};

/** GO004 — types that cannot be laid out: unknown names, uninstantiated generics, recursion. */
const typeErrors: Rule = {
  code: "GO004",
  check: ({ result }) =>
    (result.data?.analysis.errors ?? [])
      .filter((e) => e.type !== "syntax")
      .map((e): Diag => ({ code: "GO004", level: "error", message: e.message, line: e.line })),
};

/**
 * GO001 — the fieldalignment analyzer would report this struct: another order is smaller, or
 * the same size with fewer pointer bytes for the garbage collector to scan.
 */
const reorder: Rule = {
  code: "GO001",
  check: ({ result }) => {
    const data = result.data;
    const a = data?.analysis;
    if (!data || !a?.result || !a.optimized || !a.pointerBytes || data.mode !== "natural") return [];
    const saved = a.result.totalSize - a.optimized.totalSize;
    const fix = { label: "Show optimized order", apply: (s: GoLayoutSpec) => withOption(s, OPTION_MODE, "optimized") };
    if (saved > 0) {
      return [
        {
          code: "GO001",
          level: "warning",
          message: `Reordering fields saves ${plural(saved, "byte")}: ${a.result.totalSize} → ${a.optimized.totalSize}.`,
          detail: `fieldalignment: "struct of size ${a.result.totalSize} could be ${a.optimized.totalSize}". Every value, slice element and map entry of this type carries the padding.`,
          line: a.definition?.line,
          optionIds: [OPTION_MODE],
          fix,
        },
      ];
    }
    if (a.pointerBytes.optimized < a.pointerBytes.current) {
      return [
        {
          code: "GO001",
          level: "info",
          message: `Same size, but reordering cuts the bytes the GC scans from ${a.pointerBytes.current} to ${a.pointerBytes.optimized}.`,
          detail: `fieldalignment: "struct with ${a.pointerBytes.current} pointer bytes could be ${a.pointerBytes.optimized}". Pointer fields first lets the collector stop scanning earlier.`,
          line: a.definition?.line,
          optionIds: [OPTION_MODE],
          fix,
        },
      ];
    }
    return [];
  },
};

/**
 * GO002 — a 64-bit integer that is not 8-byte aligned on 32-bit targets. sync/atomic's 64-bit
 * functions need 8-byte alignment there (386, arm, 32-bit mips), and only the first word of an
 * allocated struct is guaranteed it. Checked only when the file uses sync/atomic: that is the
 * only way the misalignment matters.
 */
const atomicAlignment: Rule = {
  code: "GO002",
  check: ({ input, result }) => {
    const a = result.data?.analysis;
    if (!a?.result || ![...a.file.imports.values()].includes("sync/atomic")) return [];
    const thirtyTwo = GO_TARGETS.filter((t) => t.compiler === "gc" && t.wordSize === 4);
    const here = a.target.compiler === "gc" && a.target.wordSize === 4 ? a : analyzeGo(input, thirtyTwo[0]!.id);
    if (here.unaligned64.length === 0) return [];
    const names = here.unaligned64.map((n) => `'${n}'`).join(", ");
    const one = here.unaligned64.length === 1;
    return [
      {
        code: "GO002",
        level: "warning",
        message: `${names} ${one ? "is" : "are"} not 8-byte aligned on 32-bit targets (${thirtyTwo.map((t) => t.id).join(", ")}).`,
        detail:
          "atomic.AddInt64, LoadUint64 and the other 64-bit functions panic on a misaligned address there. Use atomic.Int64 / atomic.Uint64 (always 8-aligned), or move these fields to the start of the struct.",
        line: a.result.members.find((m) => m.member.name === here.unaligned64[0])?.member.line,
        optionIds: [OPTION_GO_TARGET],
        fix:
          a.target.wordSize === 4
            ? undefined
            : { label: `Show ${here.target.id} layout`, apply: (s) => withOption(s, OPTION_GO_TARGET, here.target.id) },
      },
    ];
  },
};

/** GO003 — a zero-size final field costs padding (gc gives it a byte so &s.f stays inside s). */
const trailingZeroSize: Rule = {
  code: "GO003",
  check: ({ result }) => {
    const a = result.data?.analysis;
    if (!a?.result || a.trailingZeroSizePadding === 0) return [];
    const last = a.result.members[a.result.members.length - 1]!;
    return [
      {
        code: "GO003",
        level: "info",
        message: `The zero-size last field '${last.member.name}' adds ${plural(a.trailingZeroSizePadding, "byte")} of padding.`,
        detail:
          "gc pads a non-empty struct whose last field has size 0, so a pointer to that field cannot point past the end of the struct. Move the field to the start to drop the padding.",
        line: last.member.line,
      },
    ];
  },
};

/** GO005 — struct types not used by the one laid out. */
const unusedTypes: Rule = {
  code: "GO005",
  check: ({ result }) => {
    const a = result.data?.analysis;
    if (!a?.definition || a.unusedTypes.length === 0) return [];
    const names = a.unusedTypes.map((n) => `'${n}'`).join(", ");
    const one = a.unusedTypes.length === 1;
    return [
      {
        code: "GO005",
        level: "info",
        message: `${names} ${one ? "is" : "are"} not laid out: only the last struct type ('${a.definition.name}') is shown.`,
        detail: `Move the type you want to inspect to the end, or use it as a field of '${a.definition.name}'.`,
      },
    ];
  },
};

/** GO006 — parser warnings. */
const parserWarnings: Rule = {
  code: "GO006",
  check: ({ result }) =>
    (result.data?.analysis.warnings ?? []).map(
      (w): Diag => ({ code: "GO006", level: "warning", message: w.message, line: w.line }),
    ),
};

export const GO_LAYOUT_RULES: readonly Rule[] = [
  syntaxErrors,
  typeErrors,
  reorder,
  atomicAlignment,
  trailingZeroSize,
  unusedTypes,
  parserWarnings,
];

export const GO_VERIFICATION_RULES: readonly Rule[] = [syntaxErrors, typeErrors, parserWarnings];
