import { describe, expect, it } from "vitest";
import { goToolDefinition } from "@sp/go-layout/definition";
import { applyAllFixes, lint } from "@sp/go-layout/lint";
import { OPTION_GO_TARGET, OPTION_MODE, TOOL_GO_STRUCT_LAYOUT, TOOL_GO_VERIFICATION_CODE } from "@sp/go-layout";
import { TOOL_MANIFESTS, loadTool } from "@sp/registry";

const createSpec = goToolDefinition(TOOL_GO_STRUCT_LAYOUT).createSpec;
const codes = (code: string, options = {}) => lint(createSpec(options), code).map((d) => d.code);

describe("Go tool family", () => {
  it("is registered under the Go family with Go input", async () => {
    const go = TOOL_MANIFESTS.filter((m) => m.family === "go");
    expect(go.map((m) => m.id)).toEqual([TOOL_GO_STRUCT_LAYOUT, TOOL_GO_VERIFICATION_CODE]);
    expect(go.every((m) => m.inputLanguage === "go")).toBe(true);
    const tool = await loadTool(TOOL_GO_STRUCT_LAYOUT);
    expect(tool.samples?.length).toBeGreaterThan(0);
    for (const sample of tool.samples!) {
      expect(tool.compute(tool.createSpec(), sample.input).error, sample.label).toBeUndefined();
    }
  });

  it("GO001 fires when reordering saves bytes, and its fix shows the optimized order", () => {
    const code = "package p\ntype S struct { a bool; b int64; c bool }";
    const diags = lint(createSpec(), code);
    const d = diags.find((x) => x.code === "GO001")!;
    expect(d.level).toBe("warning");
    expect(d.message).toContain("24 → 16");
    expect(applyAllFixes(createSpec(), code).options[OPTION_MODE]).toBe("optimized");
  });

  it("GO001 reports pointer bytes when the size cannot shrink", () => {
    const d = lint(createSpec(), "package p\ntype S struct { n int; p *int }").find((x) => x.code === "GO001")!;
    expect(d.level).toBe("info");
    expect(d.message).toContain("from 16 to 8");
  });

  it("GO002 needs sync/atomic and a misaligned 64-bit field on 32-bit targets", () => {
    const body = "type S struct { on bool; hits uint64 }";
    expect(codes(`package p\nimport "sync/atomic"\nvar _ = atomic.AddUint64\n${body}`)).toContain("GO002");
    expect(codes(`package p\n${body}`)).not.toContain("GO002");
    // atomic.Uint64 is always 8-aligned.
    expect(codes('package p\nimport "sync/atomic"\ntype S struct { on bool; hits atomic.Uint64 }')).not.toContain("GO002");
  });

  it("GO003 counts only the bytes the trailing zero-size rule adds", () => {
    const d = lint(createSpec(), "package p\ntype S struct { a int32; b int16; z struct{} }").find((x) => x.code === "GO003")!;
    // Offsets a=0, b=4, z=6; without the rule the size would be 8, with it 7 rounds to 8: no cost.
    expect(d).toBeUndefined();
    const e = lint(createSpec(), "package p\ntype S struct { a int32; z struct{} }").find((x) => x.code === "GO003")!;
    expect(e.message).toContain("4 bytes");
  });

  it("GO004 and GO005", () => {
    expect(codes("package p\ntype S struct { t foo.Bar }")).toContain("GO004");
    expect(codes("package p\ntype Unused struct { x int }\ntype S struct { a int }")).toContain("GO005");
    // A type used through a pointer or slice is not unused.
    expect(codes("package p\ntype N struct { x int }\ntype S struct { a []*N }")).not.toContain("GO005");
  });

  it("generates a verification program for the declared or optimized struct", () => {
    const tool = goToolDefinition(TOOL_GO_VERIFICATION_CODE);
    const code = "package geo\ntype S struct { a bool; b int64; c bool }";
    const plain = tool.compute(tool.createSpec(), code).files![0]!.content;
    expect(plain).toContain("package main");
    expect(plain).toContain("spunsafe.Offsetof(v.b)");
    const opt = tool.compute(tool.createSpec({ [OPTION_MODE]: "optimized" }), code).files![0]!.content;
    expect(opt).toContain("type SOptimized struct {\n\tb int64\n\ta bool\n\tc bool\n}");
    expect(opt).toContain("var v SOptimized");
    expect(tool.compute(tool.createSpec(), `${code}\nfunc main() {}`).error).toMatch(/func main/);
  });

  it("lays the struct out on every target", () => {
    const tool = goToolDefinition(TOOL_GO_STRUCT_LAYOUT);
    const table = tool.variants!(tool.createSpec({ [OPTION_GO_TARGET]: "386" }), "package p\ntype S struct { a bool; b float64; s string }");
    const row = (id: string) => table.rows.find((r) => r.options[OPTION_GO_TARGET] === id)!;
    expect(row("386").current).toBe(true);
    expect(row("386").cells.size).toBe(20);
    expect(row("amd64").cells.size).toBe(32);
  });
});
