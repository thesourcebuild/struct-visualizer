import {
  GO_OPTIMIZED_SUFFIX,
  analyzeGo,
  declaresGoMain,
  generateGoOptimizedCode,
  generateGoVerificationCode,
} from "@sp/core";
import type { CalculationResult, GoAnalysis } from "@sp/core";
import type { ToolResult, ToolResultField } from "@sp/engine";
import { readGoTarget } from "./create-spec";
import { readMode } from "./pure";
import type { GoLayoutMode } from "./pure";
import type { GoLayoutSpec } from "./spec";

/** Payload for the Go struct-layout result view. */
export interface GoLayoutData {
  analysis: GoAnalysis;
  mode: GoLayoutMode;
  /** The layout selected by `mode`. */
  display: CalculationResult | null;
  /** Source with the reordered struct appended, when reordering changes anything. */
  optimizedCode: string | null;
}

/** Whether the suggested order improves size or GC pointer bytes (what fieldalignment reports). */
export function reorderHelps(a: GoAnalysis): boolean {
  if (!a.result || !a.optimized || !a.pointerBytes) return false;
  return a.optimized.totalSize < a.result.totalSize || a.pointerBytes.optimized < a.pointerBytes.current;
}

export function buildGoLayoutData(spec: GoLayoutSpec, input: string): GoLayoutData {
  const analysis = analyzeGo(input, readGoTarget(spec.options));
  const mode = readMode(spec.options);
  const display = mode === "optimized" ? (analysis.optimized ?? analysis.result) : analysis.result;
  const optimizedCode =
    analysis.definition && reorderHelps(analysis)
      ? generateGoOptimizedCode(input, analysis.definition.name, analysis.optimizedFields)
      : null;
  return { analysis, mode, display, optimizedCode };
}

function layoutFields(data: GoLayoutData): ToolResultField[] {
  const r = data.display;
  const a = data.analysis;
  if (!r) return [];
  return [
    { label: "Total size", value: `${r.totalSize} bytes`, mono: true },
    { label: "Padding", value: `${r.totalPadding} bytes`, mono: true },
    { label: "Alignment", value: `${r.struct.alignment ?? 1} bytes`, mono: true },
    { label: "Efficiency", value: `${r.efficiency.toFixed(1)}%`, mono: true },
    { label: "Target", value: `${a.target.label}, ${a.target.compiler}` },
  ];
}

export function computeGoLayout(spec: GoLayoutSpec, input: string): ToolResult<GoLayoutData> {
  const data = buildGoLayoutData(spec, input);
  return {
    data,
    fields: layoutFields(data),
    error: data.analysis.errors[0]?.message,
  };
}

export function computeGoVerificationCode(spec: GoLayoutSpec, input: string): ToolResult<GoLayoutData> {
  const data = buildGoLayoutData(spec, input);
  const a = data.analysis;
  if (!a.result || !a.definition) {
    return { data, error: a.errors[0]?.message ?? "Fix the errors in your Go code to generate verification code." };
  }
  if (declaresGoMain(input)) {
    return { data, error: "The input declares func main; the verification program adds its own. Remove it to generate the program." };
  }

  const optimized = data.mode === "optimized";
  const source = optimized ? generateGoOptimizedCode(input, a.definition.name, a.optimizedFields) : input;
  const root = optimized ? a.definition.name + GO_OPTIMIZED_SUFFIX : a.definition.name;
  const code = generateGoVerificationCode(source, root, optimized ? a.optimizedFields : a.fields);
  const expected = optimized ? a.optimized! : a.result;
  const filename = `${a.definition.name.toLowerCase()}_verify.go`;
  const build = a.target.compiler === "gc" ? `GOARCH=${a.target.id} go run ${filename}` : `tinygo run ${filename}`;

  return {
    data,
    files: [{ filename, content: code, mimeType: "text/x-go", label: "Go verification program" }],
    fields: [
      { label: "Run", value: build, mono: true },
      { label: "Expected size", value: `${expected.totalSize} bytes, align ${expected.struct.alignment ?? 1}`, mono: true },
    ],
    working: [
      "1. Download or copy the program.",
      `2. Run it: \`go run ${filename}\` on the target machine, or cross-compile with \`GOARCH=${a.target.id} go build ${filename}\`.`,
      "3. Compare the printed size, align and offsets with the Go Struct Layout tool.",
      "Blank (`_`) fields cannot be selected, so they are not printed; their bytes still count in the size.",
    ].join("\n"),
    workingFormat: "markdown",
  };
}
