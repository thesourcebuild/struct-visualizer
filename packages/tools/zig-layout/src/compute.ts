import { ZIG_OPTIMIZED_SUFFIX, analyzeZig, declaresZigMain, formatZigStruct, generateZigVerificationCode, getZigTarget, zigTargetFlags } from "@sp/core";
import type { CalculationResult, ZigAnalysis } from "@sp/core";
import type { ToolResult, ToolResultField } from "@sp/engine";
import { readBuild, readZigTarget } from "./create-spec";
import { DEFAULT_ERROR_LIMIT, readMode } from "./pure";
import type { ZigLayoutMode } from "./pure";
import type { ZigLayoutSpec } from "./spec";

/** Payload for the Zig layout result view. */
export interface ZigLayoutData {
  analysis: ZigAnalysis;
  mode: ZigLayoutMode;
  /** The layout selected by `mode`. */
  display: CalculationResult | null;
  /** The extern struct with its fields reordered, when that saves space. */
  optimizedCode: string | null;
}

/** The kind of layout the definition has, as written. */
export function layoutLabel(a: ZigAnalysis): string {
  const d = a.definition;
  if (!d) return "";
  if (d.kind === "tuple") return "tuple";
  if (d.kind === "enum") return `enum(${a.enumTag ?? ""})`;
  const head = d.layout === "auto" ? d.kind : `${d.layout} ${d.kind}`;
  if (d.kind === "union" && d.layout === "auto" && (d.decl.unionEnum || d.decl.arg)) return "union(enum)";
  return head;
}

/** Whether the language defines the layout (extern, packed) or the compiler chooses it. */
export function layoutGuaranteed(a: ZigAnalysis): boolean {
  const d = a.definition;
  return !!d && (d.layout !== "auto" || d.kind === "enum");
}

/** How a union knows which field it holds, in words. */
export function describeUnionTag(a: ZigAnalysis): string | null {
  const t = a.unionTag;
  if (!t) return null;
  const where = `${t.type} at offset ${t.offset}`;
  return t.kind === "safety" ? `hidden safety tag (${where}), in ${a.mode} only` : where;
}

export function buildZigLayoutData(spec: ZigLayoutSpec, input: string): ZigLayoutData {
  const analysis = analyzeZig(input, readZigTarget(spec.options), readBuild(spec.options));
  const mode = readMode(spec.options);
  const display = mode === "optimized" ? (analysis.optimized ?? analysis.result) : analysis.result;
  const def = analysis.definition;
  const optimizedCode = analysis.optimizedOrder && def ? formatZigStruct(input, def.decl, analysis.optimizedOrder, def.name) : null;
  return { analysis, mode, display, optimizedCode };
}

function layoutFields(data: ZigLayoutData): ToolResultField[] {
  const r = data.display;
  const a = data.analysis;
  if (!r) return [];
  const fields: ToolResultField[] = [
    { label: "Total size", value: `${r.totalSize} bytes`, mono: true },
    { label: "Padding", value: `${r.totalPadding} bytes`, mono: true },
    { label: "Alignment", value: `${r.struct.alignment ?? 1} bytes`, mono: true },
  ];
  if (a.optionalSize !== null && a.definition) fields.push({ label: `?${a.definition.name}`, value: `${a.optionalSize} bytes`, mono: true });
  const tag = describeUnionTag(a);
  if (tag) fields.push({ label: "Tag", value: tag });
  if (a.packedBacking) fields.push({ label: "Backing integer", value: a.packedBacking, mono: true });
  if (a.enumTag) fields.push({ label: "Tag type", value: a.enumTag, mono: true });
  fields.push({ label: "Target", value: `${a.target.id}${a.target.arch === "x86_64" ? ` (${a.cpu.id})` : ""}, ${a.mode}`, mono: true });
  return fields;
}

export function computeZigLayout(spec: ZigLayoutSpec, input: string): ToolResult<ZigLayoutData> {
  const data = buildZigLayoutData(spec, input);
  return { data, fields: layoutFields(data), error: data.analysis.errors[0]?.message };
}

export function computeZigVerificationCode(spec: ZigLayoutSpec, input: string): ToolResult<ZigLayoutData> {
  const data = buildZigLayoutData(spec, input);
  const a = data.analysis;
  if (!a.result || !a.definition) {
    return { data, error: a.errors[0]?.message ?? "Fix the errors in your Zig code to generate verification code." };
  }
  if (declaresZigMain(input)) {
    return { data, error: "The input declares main; the verification program adds its own. Remove it to generate the program." };
  }

  const name = a.definition.name;
  const optimized = data.mode === "optimized" && a.optimizedOrder !== null && a.optimized !== null;
  const root = optimized ? name + ZIG_OPTIMIZED_SUFFIX : name;
  const source = optimized
    ? `${input.trimEnd()}\n\n// ${name} with its fields in the order Zig gives a plain struct.\n${formatZigStruct(input, a.definition.decl, a.optimizedOrder!, root)}\n`
    : input;
  const code = generateZigVerificationCode(source, optimized ? { ...a, definition: { ...a.definition, name: root } } : a, root);
  const expected = optimized ? a.optimized! : a.result;
  const filename = `${name.toLowerCase()}_verify.zig`;
  const target = getZigTarget(a.target.id);
  const errorLimit = a.errorLimit === DEFAULT_ERROR_LIMIT ? [] : ["--error-limit", String(a.errorLimit)];
  const flags = [...zigTargetFlags(target, a.cpu.id), ...errorLimit].join(" ");
  const command = `zig run ${flags} -O ${a.mode} ${filename}`;

  return {
    data,
    files: [{ filename, content: code, mimeType: "text/x-zig", label: "Zig verification program" }],
    fields: [
      { label: "Run", value: command, mono: true },
      { label: "Expected size", value: `${expected.totalSize} bytes, align ${expected.struct.alignment ?? 1} on ${a.target.id}, ${a.mode}`, mono: true },
    ],
    working: [
      "1. Download or copy the program.",
      `2. On a ${target.label} machine, run it with \`${command}\` (Zig 0.16). For another machine, build it with \`zig build-exe ${flags} -O ${a.mode} ${filename}\` and run it there.`,
      "3. Compare the printed size, align and offsets with the Zig Type Layout tool.",
      ...(errorLimit.length
        ? ["zig counts every error name in the program against --error-limit, std.debug.print's own included, so with a small limit zig may refuse the program; its message says the limit it needs."]
        : []),
      layoutGuaranteed(a)
        ? "This layout is defined by the language."
        : "A plain struct's field order is what this compiler chooses; other Zig versions may choose differently.",
    ].join("\n"),
    workingFormat: "markdown",
  };
}
