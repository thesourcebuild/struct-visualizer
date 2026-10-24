import { applyAllFixes as applyAllFixesGeneric, runLint } from "@sp/engine";
import type { Diagnostic } from "@sp/contracts";
import { computeZigLayout } from "../compute";
import type { ZigLayoutSpec } from "../spec";
import { ZIG_LAYOUT_RULES } from "./rules";

/** Lint a Zig layout spec against an input. */
export function lint(spec: ZigLayoutSpec, input: string): Diagnostic<ZigLayoutSpec>[] {
  return runLint(ZIG_LAYOUT_RULES, { spec, input, result: computeZigLayout(spec, input) });
}

/** Apply every one-click fix the rules offer for this input. */
export function applyAllFixes(spec: ZigLayoutSpec, input: string): ZigLayoutSpec {
  return applyAllFixesGeneric(spec, ZIG_LAYOUT_RULES, (s) => ({ spec: s, input, result: computeZigLayout(s, input) }));
}
