import { applyAllFixes as applyAllFixesGeneric, runLint } from "@sp/engine";
import type { Diagnostic } from "@sp/contracts";
import { computeGoLayout } from "../compute";
import type { GoLayoutSpec } from "../spec";
import { GO_LAYOUT_RULES } from "./rules";

/** Lint a Go struct-layout spec against an input. */
export function lint(spec: GoLayoutSpec, input: string): Diagnostic<GoLayoutSpec>[] {
  return runLint(GO_LAYOUT_RULES, { spec, input, result: computeGoLayout(spec, input) });
}

/** Apply every one-click fix the rules offer for this input. */
export function applyAllFixes(spec: GoLayoutSpec, input: string): GoLayoutSpec {
  return applyAllFixesGeneric(spec, GO_LAYOUT_RULES, (s) => ({ spec: s, input, result: computeGoLayout(s, input) }));
}
