import type { Diagnostic, LintRule } from "@sp/contracts";
import type { LintContext } from "@sp/engine";
import type { RustLayoutData } from "../compute";
import { OPTION_MODE, withOption } from "../pure";
import type { RustLayoutSpec } from "../spec";

type Ctx = LintContext<RustLayoutSpec, RustLayoutData>;
type Rule = LintRule<Ctx, RustLayoutSpec>;
type Diag = Diagnostic<RustLayoutSpec>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** clippy::large_enum_variant's default threshold. */
const LARGE_VARIANT_BYTES = 200;

/** RS000 — syntax errors. */
const syntaxErrors: Rule = {
  code: "RS000",
  check: ({ result }) =>
    (result.data?.analysis.errors ?? [])
      .filter((e) => e.type === "syntax")
      .map((e): Diag => ({ code: "RS000", level: "error", message: e.message, line: e.line })),
};

/** RS004 — types that cannot be laid out: unknown names, generics without arguments, unsized. */
const typeErrors: Rule = {
  code: "RS004",
  check: ({ result }) =>
    (result.data?.analysis.errors ?? [])
      .filter((e) => e.type !== "syntax")
      .map((e): Diag => ({ code: "RS004", level: "error", message: e.message, line: e.line })),
};

/** RS001 — a repr(C) struct keeps its declared order, and another order is smaller. */
const reorder: Rule = {
  code: "RS001",
  check: ({ result }) => {
    const data = result.data;
    const a = data?.analysis;
    if (!data || !a?.result || !a.optimized || data.mode !== "natural") return [];
    const saved = a.result.totalSize - a.optimized.totalSize;
    return [
      {
        code: "RS001",
        level: "warning",
        message: `repr(C) keeps the declared order; reordering the fields saves ${plural(saved, "byte")}: ${a.result.totalSize} → ${a.optimized.totalSize}.`,
        detail: "The field order rustc would pick is also a valid repr(C) order. Change the declaration only if nothing on the C side depends on it.",
        line: a.definition?.line,
        optionIds: [OPTION_MODE],
        fix: { label: "Show optimized order", apply: (s: RustLayoutSpec) => withOption(s, OPTION_MODE, "optimized") },
      },
    ];
  },
};

/** RS003 — packed structs with fields that lose their alignment cannot be borrowed field by field. */
const packedBorrow: Rule = {
  code: "RS003",
  check: ({ result }) => {
    const a = result.data?.analysis;
    const pack = a?.definition?.repr.packed;
    if (!a?.result || pack === undefined) return [];
    const affected = a.result.members.filter((m) => m.alignment > pack).map((m) => m.member.name);
    if (affected.length === 0) return [];
    const names = affected.map((n) => `'${n}'`).join(", ");
    return [
      {
        code: "RS003",
        level: "info",
        message: `${names} may be unaligned in this packed ${a.definition!.kind}: references to ${affected.length === 1 ? "it" : "them"} are an error (E0793).`,
        detail: "Copy the value out ({ s.field }), or use core::ptr::addr_of!(s.field).read_unaligned().",
        line: a.definition!.line,
      },
    ];
  },
};

/** RS005 — one variant is much larger than the others (clippy::large_enum_variant). */
const largeVariant: Rule = {
  code: "RS005",
  check: ({ result }) => {
    const a = result.data?.analysis;
    const variants = a?.enumInfo?.variants;
    if (!a?.result || !variants || variants.length < 2) return [];
    const sorted = [...variants].sort((x, y) => y.size - x.size);
    const [largest, second] = sorted;
    if (!largest || !second || largest.size - second.size < LARGE_VARIANT_BYTES) return [];
    return [
      {
        code: "RS005",
        level: "warning",
        message: `Variant '${largest.name}' is ${largest.size} bytes; the next largest ('${second.name}') is ${second.size}. Every '${a.definition!.name}' value takes ${a.result.totalSize} bytes.`,
        detail: `Box the large variant's data (e.g. ${largest.name}(Box<...>)) so the enum shrinks to the size of the others plus a pointer.`,
        line: a.file.items.get(a.definition!.name)?.kind === "enum" ? a.definition!.line : undefined,
      },
    ];
  },
};

/** RS006 — definitions not used by the one laid out. */
const unusedTypes: Rule = {
  code: "RS006",
  check: ({ result }) => {
    const a = result.data?.analysis;
    if (!a?.definition || a.unusedTypes.length === 0) return [];
    const names = a.unusedTypes.map((n) => `'${n}'`).join(", ");
    const one = a.unusedTypes.length === 1;
    return [
      {
        code: "RS006",
        level: "info",
        message: `${names} ${one ? "is" : "are"} not laid out: only the last definition ('${a.definition.name}') is shown.`,
        detail: `Move the definition you want to inspect to the end, or use it in a field of '${a.definition.name}'.`,
      },
    ];
  },
};

/** RS007 — parser warnings. */
const parserWarnings: Rule = {
  code: "RS007",
  check: ({ result }) =>
    (result.data?.analysis.warnings ?? []).map(
      (w): Diag => ({ code: "RS007", level: "warning", message: w.message, line: w.line }),
    ),
};

export const RUST_LAYOUT_RULES: readonly Rule[] = [
  syntaxErrors,
  typeErrors,
  reorder,
  packedBorrow,
  largeVariant,
  unusedTypes,
  parserWarnings,
];

export const RUST_VERIFICATION_RULES: readonly Rule[] = [syntaxErrors, typeErrors, parserWarnings];
