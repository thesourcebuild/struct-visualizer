import {
  CCodeGenerator,
  PaddingCalculator,
  analyzeStruct,
  applyPacking,
  bindingLanguages,
  bindingTargetName,
  dataModels,
  generateBindings,
  osTypes,
  targetArchitectures,
} from "@sp/core";
import type { CalculationResult, StructAnalysis } from "@sp/core";
import type { ToolResult, ToolResultField } from "@sp/engine";
import { readBindingLanguage, readLanguage, readMode, readPacking } from "./pure";
import type { LayoutMode } from "./pure";
import { selectionFromSpec } from "./resolve";
import type { LayoutSpec } from "./spec";

/** Payload for the struct-layout result view. */
export interface LayoutData {
  analysis: StructAnalysis;
  mode: LayoutMode;
  /** The layout selected by `mode` (falls back to natural when unavailable). */
  display: CalculationResult | null;
  /** Reordered source for the optimized layout, when reordering changes anything. */
  optimizedCode: string | null;
  platformLabel: { target: string; dataModel: string; os: string; architecture: string };
}

export function buildLayoutData(spec: LayoutSpec, input: string): LayoutData {
  const analysis = analyzeStruct(input, selectionFromSpec(spec), { packing: readPacking(spec.options), language: readLanguage(spec.options) });
  const mode = readMode(spec.options);
  const { result, packed, optimized, platform } = analysis;

  const display =
    mode === "packed" ? (packed ?? result) : mode === "optimized" ? (optimized ?? result) : result;

  const optimizedCode =
    result && optimized && result.totalSize !== optimized.totalSize
      ? CCodeGenerator.generateOptimizedCode(result.struct, optimized.struct)
      : null;

  return {
    analysis,
    mode,
    display,
    optimizedCode,
    platformLabel: {
      target: targetArchitectures[platform.target]?.displayName ?? platform.target,
      dataModel: dataModels[platform.dataModel]?.displayName ?? platform.dataModel,
      os: osTypes[platform.os]?.displayName ?? platform.os,
      architecture: platform.architecture.displayName,
    },
  };
}

function layoutFields(data: LayoutData): ToolResultField[] {
  const r = data.display;
  if (!r) return [];
  return [
    { label: "Total size", value: `${r.totalSize} bytes`, mono: true },
    { label: "Padding", value: `${r.totalPadding} bytes`, mono: true },
    { label: "Alignment", value: `${r.struct.alignment ?? 1} bytes`, mono: true },
    { label: "Efficiency", value: `${r.efficiency.toFixed(1)}%`, mono: true },
    {
      label: "Platform",
      value: `${data.platformLabel.target} · ${data.platformLabel.dataModel} · ${data.platformLabel.os}`,
    },
  ];
}

export function computeLayout(spec: LayoutSpec, input: string): ToolResult<LayoutData> {
  const data = buildLayoutData(spec, input);
  return {
    data,
    fields: layoutFields(data),
    error: data.analysis.errors.length > 0 ? data.analysis.errors[0]!.message : undefined,
  };
}

export function computeVerificationCode(spec: LayoutSpec, input: string): ToolResult<LayoutData> {
  const data = buildLayoutData(spec, input);
  const { result, optimized } = data.analysis;
  if (!result) {
    return {
      data,
      error:
        data.analysis.errors[0]?.message ??
        "Fix the errors in your struct or union to generate verification code.",
    };
  }

  const language = readLanguage(spec.options);
  const cpp = language !== "c";
  const useOptimized = data.mode === "optimized" && optimized;
  // Packed: the very source the Struct Layout tool laid out for this mode, packing written in.
  const usePacked = data.mode === "packed" && data.analysis.packed;
  const { platform } = data.analysis;
  const target = { architecture: platform.architecture, dataModel: platform.dataModel, language };
  const code = useOptimized
    ? CCodeGenerator.generateVerificationCode(
        CCodeGenerator.generateOptimizedProgram(input, result.struct, optimized.struct),
        target,
        CCodeGenerator.getOptimizedRootName(result.struct, optimized.struct),
        cpp ? "cpp" : "c",
      )
    : CCodeGenerator.generateVerificationCode(
        usePacked ? applyPacking(input, data.analysis.packing) : input,
        target,
        result.struct.name,
        cpp ? "cpp" : "c",
      );
  const expected = useOptimized ? optimized : usePacked ? data.analysis.packed! : result;

  const filename = `${result.struct.name}_verify.${cpp ? "cpp" : "c"}`;
  // The target's own compiler: MSVC on Windows, GCC (or Clang) elsewhere.
  const msvc = platform.architecture.cppAbi === "msvc";
  const compile = msvc
    ? `cl /nologo /std:${cpp ? language : "c11"} ${cpp ? "/EHsc " : ""}/Fetest.exe ${filename}`
    : cpp
      ? `g++ -std=${language} -o test ${filename}`
      : `gcc -o test ${filename}`;

  return {
    data,
    text: code,
    files: [
      {
        filename,
        content: code,
        mimeType: "text/x-c",
        label: cpp ? "C++ verification program" : "C verification program",
      },
    ],
    fields: [
      { label: "Compile", value: compile, mono: true },
      { label: "Run", value: msvc ? "test.exe" : "./test", mono: true },
      {
        label: "Expected sizeof",
        value: `${expected.totalSize} bytes on ${data.platformLabel.architecture}`,
        mono: true,
      },
    ],
    working: [
      "1. Download or copy the program.",
      `2. Compile: \`${compile}\``,
      "3. Run it and compare the printed sizeof/offsetof values with the Struct Layout tool.",
      "Results reflect your actual compiler and ABI; they may differ from the selected target.",
    ].join("\n"),
    workingFormat: "markdown",
  };
}

export function computeBindings(spec: LayoutSpec, input: string): ToolResult<LayoutData> {
  const data = buildLayoutData(spec, input);
  const shown = data.display;
  if (!shown) {
    return { data, error: data.analysis.errors[0]?.message ?? "Fix the errors in your struct or union to generate a binding." };
  }
  const language = readBindingLanguage(spec.options);
  const { platform } = data.analysis;
  const calculator = new PaddingCalculator(platform.architecture, platform.dataModel);
  const binding = generateBindings(shown, platform, calculator, language);
  if (binding.error) return { data, error: binding.error };

  const target = bindingTargetName(language, platform);
  const fields: ToolResultField[] = [
    { label: "Size", value: `${shown.totalSize} bytes on ${data.platformLabel.architecture}`, mono: true },
    { label: language === "go" ? "GOARCH" : "Target", value: target ?? "any machine (the layout is written out in full)", mono: target !== undefined },
    ...binding.notes.map((note) => ({ label: "Note", value: note })),
  ];
  return {
    data,
    text: binding.code,
    files: [{ filename: binding.filename, content: binding.code, mimeType: "text/plain", label: `${bindingLanguages[language].label} binding` }],
    fields,
  };
}
