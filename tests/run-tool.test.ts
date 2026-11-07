import { describe, expect, it } from "vitest";
import type { AnyToolDefinition } from "@sp/engine";
import { layoutToolDefinition } from "@sp/layout/definition";
import { runTool, runVariants } from "../apps/web/app/workbench/run-tool";

const layout = layoutToolDefinition("struct-layout") as unknown as AnyToolDefinition;
const spec = layout.createSpec();
const INPUT = "struct S { char a; int b; };";

const boom = (): never => {
  throw new Error("boom");
};

/** The workbench runs tool code on every keystroke; a throw anywhere in it must not escape. */
describe("running a tool for the workbench", () => {
  it("computes, lints and tags", () => {
    const run = runTool(layout, spec, INPUT);
    expect(run.failure).toBeUndefined();
    expect(run.result.data).toBeDefined();
    expect(run.tags).toBeDefined();
  });

  it("reports a compute that throws as an error result", () => {
    const run = runTool({ ...layout, compute: boom }, spec, INPUT);
    expect(run.failure).toBe("boom");
    expect(run.result).toEqual({ error: "boom" });
    expect(run.tags).toEqual(layout.variantTag!(spec, INPUT));
  });

  it("reports a lint rule that throws and keeps the result", () => {
    const run = runTool({ ...layout, lintRules: [{ code: "X", check: boom }] }, spec, INPUT);
    expect(run.failure).toBe("boom");
    expect(run.result.data).toBeDefined();
    expect(run.diagnostics).toEqual([]);
  });

  it("reports tags that throw and keeps the result and diagnostics", () => {
    const run = runTool({ ...layout, variantTag: boom }, spec, INPUT);
    expect(run.failure).toBe("boom");
    expect(run.result.data).toBeDefined();
    expect(run.diagnostics).toEqual(runTool(layout, spec, INPUT).diagnostics);
    expect(run.tags).toBeUndefined();
  });

  it("reports a variants table that throws", () => {
    expect(runVariants(layout, spec, INPUT).table?.rows.length).toBeGreaterThan(0);
    expect(runVariants({ ...layout, variants: boom }, spec, INPUT)).toEqual({ table: undefined, failure: "boom" });
  });
});
