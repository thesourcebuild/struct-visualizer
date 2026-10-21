import { DIAGNOSTIC_LEVEL_ORDER } from "@sp/contracts";
import type { Diagnostic, LintRule } from "@sp/contracts";

/** Run every rule and return diagnostics ordered by severity, then rule code. */
export function runLint<TCtx, TSpec>(
  rules: readonly LintRule<TCtx, TSpec>[],
  ctx: TCtx,
): Diagnostic<TSpec>[] {
  const out: Diagnostic<TSpec>[] = [];
  for (const rule of rules) {
    for (const d of rule.check(ctx)) out.push(d);
  }
  return out.sort(
    (a, b) =>
      DIAGNOSTIC_LEVEL_ORDER[a.level] - DIAGNOSTIC_LEVEL_ORDER[b.level] ||
      a.code.localeCompare(b.code),
  );
}

/**
 * Apply every available fix, re-linting after each one, until none is left or the limit is
 * hit. Re-linting matters: one fix can make another rule's fix obsolete (switching to packed
 * mode removes the "reorder to save padding" suggestion), so applying a stale list in one pass
 * would act on diagnostics that no longer exist.
 *
 * Only error and warning fixes are applied: an info-level "fix" is a suggestion to look at
 * something else (compare on the other OS), and applying it can flip back and forth forever.
 * Each rule's fix is applied at most once for the same reason.
 *
 * `contextFor` rebuilds the lint context for a spec, because rules usually need the computed
 * result as well as the spec.
 */
export function applyAllFixes<TCtx, TSpec>(
  spec: TSpec,
  rules: readonly LintRule<TCtx, TSpec>[],
  contextFor: (spec: TSpec) => TCtx,
): TSpec {
  let current = spec;
  const applied = new Set<string>();
  for (;;) {
    const next = runLint(rules, contextFor(current)).find(
      (d) => d.fix && d.level !== "info" && !applied.has(d.code),
    );
    if (!next?.fix) return current;
    applied.add(next.code);
    current = next.fix.apply(current);
  }
}
