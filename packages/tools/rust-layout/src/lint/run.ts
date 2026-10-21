import { applyAllFixes as applyAllFixesGeneric, runLint } from "@sp/engine";
import type { Diagnostic } from "@sp/contracts";
import { computeRustLayout } from "../compute";
import type { RustLayoutSpec } from "../spec";
import { RUST_LAYOUT_RULES } from "./rules";

/** Lint a Rust layout spec against an input. */
export function lint(spec: RustLayoutSpec, input: string): Diagnostic<RustLayoutSpec>[] {
  return runLint(RUST_LAYOUT_RULES, { spec, input, result: computeRustLayout(spec, input) });
}

/** Apply every one-click fix the rules offer for this input. */
export function applyAllFixes(spec: RustLayoutSpec, input: string): RustLayoutSpec {
  return applyAllFixesGeneric(spec, RUST_LAYOUT_RULES, (s) => ({ spec: s, input, result: computeRustLayout(s, input) }));
}
