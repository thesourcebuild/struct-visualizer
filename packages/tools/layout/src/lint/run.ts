import { applyAllFixes as applyAllFixesGeneric, runLint } from "@sp/engine";
import type { Diagnostic } from "@sp/contracts";
import { computeLayout } from "../compute";
import type { LayoutSpec } from "../spec";
import { LAYOUT_RULES } from "./rules";

/** Lint a struct-layout spec against an input, computing the layout the rules inspect. */
export function lint(spec: LayoutSpec, input: string): Diagnostic<LayoutSpec>[] {
  return runLint(LAYOUT_RULES, { spec, input, result: computeLayout(spec, input) });
}

/** Apply every one-click fix the rules offer for this input. */
export function applyAllFixes(spec: LayoutSpec, input: string): LayoutSpec {
  return applyAllFixesGeneric(spec, LAYOUT_RULES, (s) => ({
    spec: s,
    input,
    result: computeLayout(s, input),
  }));
}
