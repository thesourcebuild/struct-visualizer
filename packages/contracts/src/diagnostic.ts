/**
 * Lint diagnostics. Rules are pure functions over (spec, input, result) and carry stable
 * codes (SP001, ...) so docs, tests and the UI can refer to them.
 */
export type DiagnosticLevel = "error" | "warning" | "info";

export const DIAGNOSTIC_LEVEL_ORDER: Record<DiagnosticLevel, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export interface DiagnosticFix<TSpec> {
  /** Button label, e.g. "Show optimized layout". */
  label: string;
  apply(spec: TSpec): TSpec;
}

export interface Diagnostic<TSpec = unknown> {
  code: string;
  level: DiagnosticLevel;
  message: string;
  detail?: string;
  /** Options this diagnostic is about, so the form can highlight them. */
  optionIds?: readonly string[];
  /** 1-based source line, when the diagnostic points into the input. */
  line?: number;
  fix?: DiagnosticFix<TSpec>;
}

export interface LintRule<TCtx, TSpec = unknown> {
  code: string;
  check(ctx: TCtx): Diagnostic<TSpec>[];
}
