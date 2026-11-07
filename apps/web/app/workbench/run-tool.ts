import { runLint } from "@sp/engine";
import type { AnyToolDefinition, ToolResult, ToolSpecBase, ToolVariantTable } from "@sp/engine";
import type { Diagnostic } from "@sp/contracts";

export interface ToolRun {
  result: ToolResult;
  diagnostics: Diagnostic<ToolSpecBase>[];
  /** Tags for option visibility. */
  tags: string | readonly string[] | undefined;
  /** What the tool's code threw, if it did: a bug in the tool, shown instead of taking the page down. */
  failure: string | undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compute, lint and tag one input. Each step that throws is reported in `failure` and the others
 * still run: a failed compute gives an error result that lint still sees, and a lint rule or the
 * tags failing keeps the computed result.
 */
export function runTool(tool: AnyToolDefinition, spec: ToolSpecBase, input: string): ToolRun {
  let failure: string | undefined;
  const attempt = <T>(step: () => T, fallback: (message: string) => T): T => {
    try {
      return step();
    } catch (err) {
      failure ??= message(err);
      return fallback(message(err));
    }
  };
  const result = attempt<ToolResult>(() => tool.compute(spec, input), (error) => ({ error }));
  const diagnostics = attempt(() => runLint(tool.lintRules, { spec, input, result }), () => []);
  const tags = attempt(() => tool.variantTag?.(spec, input), () => undefined);
  return { result, diagnostics, tags, failure };
}

/** The variants table for one input, or what the tool's code threw building it. */
export function runVariants(
  tool: AnyToolDefinition,
  spec: ToolSpecBase,
  input: string,
): { table: ToolVariantTable | undefined; failure: string | undefined } {
  try {
    return { table: tool.variants?.(spec, input), failure: undefined };
  } catch (err) {
    return { table: undefined, failure: message(err) };
  }
}
