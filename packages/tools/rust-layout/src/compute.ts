import {
  RUST_OPTIMIZED_SUFFIX,
  analyzeRust,
  declaresRustMain,
  formatRustStruct,
  generateRustVerificationCode,
  parseRust,
} from "@sp/core";
import type { CalculationResult, RustAnalysis, RustStruct } from "@sp/core";
import type { ToolResult, ToolResultField } from "@sp/engine";
import { readRustTarget } from "./create-spec";
import { readMode } from "./pure";
import type { RustLayoutMode } from "./pure";
import type { RustLayoutSpec } from "./spec";

/** Payload for the Rust layout result view. */
export interface RustLayoutData {
  analysis: RustAnalysis;
  mode: RustLayoutMode;
  /** The layout selected by `mode`. */
  display: CalculationResult | null;
  /** The repr(C) struct with its fields reordered, when that saves space. */
  optimizedCode: string | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How an enum stores which variant it holds, in words. */
export function describeDiscriminant(a: RustAnalysis): string | null {
  const e = a.enumInfo;
  if (!e) return null;
  switch (e.encoding) {
    case "tagged":
      return `${e.tag!.signed ? "i" : "u"}${e.tag!.bytes * 8} tag at offset 0`;
    case "niche":
      return `in unused values of the ${plural(e.nicheField!.bytes, "byte")} at offset ${e.nicheField!.offset} (no tag)`;
    case "single":
      return "none: only one variant can exist";
    case "empty":
      return "none: no value can exist";
  }
}

/** The repr(...) the definition has, as written. */
export function reprLabel(a: RustAnalysis): string {
  const r = a.definition?.repr;
  if (!r) return "";
  const parts: string[] = [];
  if (r.c) parts.push("C");
  if (r.transparent) parts.push("transparent");
  if (r.int) parts.push(r.int);
  if (r.packed !== undefined) parts.push(r.packed === 1 ? "packed" : `packed(${r.packed})`);
  if (r.align !== undefined) parts.push(`align(${r.align})`);
  return parts.length ? `repr(${parts.join(", ")})` : "repr(Rust)";
}

export function buildRustLayoutData(spec: RustLayoutSpec, input: string): RustLayoutData {
  const analysis = analyzeRust(input, readRustTarget(spec.options));
  const mode = readMode(spec.options);
  const display = mode === "optimized" ? (analysis.optimized ?? analysis.result) : analysis.result;
  const item = analysis.definition ? analysis.file.items.get(analysis.definition.name) : undefined;
  const optimizedCode =
    analysis.optimizedOrder && item?.kind === "struct" ? formatRustStruct(item, analysis.optimizedOrder) : null;
  return { analysis, mode, display, optimizedCode };
}

function layoutFields(data: RustLayoutData): ToolResultField[] {
  const r = data.display;
  const a = data.analysis;
  if (!r) return [];
  const fields: ToolResultField[] = [
    { label: "Total size", value: `${r.totalSize} bytes`, mono: true },
    { label: "Padding", value: `${r.totalPadding} bytes`, mono: true },
    { label: "Alignment", value: `${r.struct.alignment ?? 1} bytes`, mono: true },
  ];
  if (a.optionSize !== null && a.definition) {
    fields.push({ label: `Option<${a.definition.name}>`, value: `${a.optionSize} bytes`, mono: true });
  }
  const discr = describeDiscriminant(a);
  if (discr) fields.push({ label: "Discriminant", value: discr });
  fields.push({ label: "Target", value: a.target.id, mono: true });
  return fields;
}

export function computeRustLayout(spec: RustLayoutSpec, input: string): ToolResult<RustLayoutData> {
  const data = buildRustLayoutData(spec, input);
  return { data, fields: layoutFields(data), error: data.analysis.errors[0]?.message };
}

export function computeRustVerificationCode(spec: RustLayoutSpec, input: string): ToolResult<RustLayoutData> {
  const data = buildRustLayoutData(spec, input);
  const a = data.analysis;
  if (!a.result || !a.definition) {
    return { data, error: a.errors[0]?.message ?? "Fix the errors in your Rust code to generate verification code." };
  }
  if (declaresRustMain(input)) {
    return { data, error: "The input declares fn main; the verification program adds its own. Remove it to generate the program." };
  }

  const name = a.definition.name;
  const optimized = data.mode === "optimized" && a.optimizedOrder !== null && a.optimized !== null;
  const item = a.file.items.get(name) as RustStruct;
  const source = optimized
    ? `${input.trimEnd()}\n\n// ${name} with its fields in the order rustc would choose.\n${formatRustStruct(item, a.optimizedOrder!, name + RUST_OPTIMIZED_SUFFIX)}\n`
    : input;
  const root = optimized ? name + RUST_OPTIMIZED_SUFFIX : name;
  const code = generateRustVerificationCode(source, root, parseRust(source));
  const expected = optimized ? a.optimized! : a.result;
  const filename = `${name.toLowerCase()}_verify.rs`;
  const native = `rustc ${filename} && ./${filename.replace(/\.rs$/, "")}`;

  return {
    data,
    text: code,
    files: [{ filename, content: code, mimeType: "text/x-rust", label: "Rust verification program" }],
    fields: [
      { label: "Run", value: native, mono: true },
      { label: "Expected size", value: `${expected.totalSize} bytes, align ${expected.struct.alignment ?? 1} on ${a.target.id}`, mono: true },
    ],
    working: [
      "1. Download or copy the program.",
      `2. Run it with \`${native}\` (Rust 1.77 or newer, for offset_of!). For another target, put it in a binary crate and use \`cargo run --target ${a.target.id}\`.`,
      "3. Compare the printed size, align and offsets with the Rust Type Layout tool.",
      a.definition.repr.c || a.definition.repr.transparent
        ? "This layout is guaranteed by the repr."
        : "repr(Rust) layouts are what this rustc chooses; other compiler versions may differ.",
    ].join("\n"),
    workingFormat: "markdown",
  };
}
