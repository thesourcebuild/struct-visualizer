import { describe, expect, it } from "vitest";
import { zigToolDefinition } from "@sp/zig-layout/definition";
import { applyAllFixes, lint } from "@sp/zig-layout/lint";
import { OPTION_BUILD_MODE, OPTION_MODE, OPTION_ZIG_CPU, OPTION_ZIG_TARGET, TOOL_ZIG_STRUCT_LAYOUT, TOOL_ZIG_VERIFICATION_CODE } from "@sp/zig-layout";
import { TOOL_MANIFESTS, loadTool } from "@sp/registry";

const createSpec = zigToolDefinition(TOOL_ZIG_STRUCT_LAYOUT).createSpec;
const codes = (code: string, options = {}) => lint(createSpec(options), code).map((d) => d.code);

describe("Zig tool family", () => {
  it("is registered under the Zig family with Zig input, and every sample computes in every build mode", async () => {
    const zig = TOOL_MANIFESTS.filter((m) => m.family === "zig");
    expect(zig.map((m) => m.id)).toEqual([TOOL_ZIG_STRUCT_LAYOUT, TOOL_ZIG_VERIFICATION_CODE]);
    expect(zig.every((m) => m.inputLanguage === "zig")).toBe(true);
    const tool = await loadTool(TOOL_ZIG_STRUCT_LAYOUT);
    for (const mode of ["Debug", "ReleaseSafe", "ReleaseFast", "ReleaseSmall"]) {
      for (const sample of tool.samples!) {
        expect(tool.compute(tool.createSpec({ [OPTION_BUILD_MODE]: mode }), sample.input).error, `${mode}: ${sample.label}`).toBeUndefined();
      }
    }
  });

  it("ZG001 only for extern structs, with a fix", () => {
    const c = "const S = extern struct { a: u8, b: u64, c: u8 };";
    const d = lint(createSpec(), c).find((x) => x.code === "ZG001")!;
    expect(d.message).toContain("24 → 16");
    expect(applyAllFixes(createSpec(), c).options[OPTION_MODE]).toBe("optimized");
    // Zig already orders a plain struct.
    expect(codes("const S = struct { a: u8, b: u64, c: u8 };")).not.toContain("ZG001");
  });

  it("ZG002 for a bare union's safety tag, in the build modes that have one", () => {
    const u = "const U = union { a: u32, b: u8 };";
    expect(codes(u)).toContain("ZG002");
    expect(codes(u, { [OPTION_BUILD_MODE]: "ReleaseFast" })).not.toContain("ZG002");
    expect(codes("const U = union(enum) { a: u32, b: u8 };")).not.toContain("ZG002");
    const tool = zigToolDefinition(TOOL_ZIG_STRUCT_LAYOUT);
    expect(tool.compute(tool.createSpec(), u).data!.display!.totalSize).toBe(8);
    expect(tool.compute(tool.createSpec({ [OPTION_BUILD_MODE]: "ReleaseFast" }), u).data!.display!.totalSize).toBe(4);
  });

  it("lays vectors out for the selected CPU, which only Zig's x86-64 backend (Debug on x86-64 Linux) looks at", () => {
    const v = "const S = struct { v: @Vector(8, f32), a: u8 };";
    const tool = zigToolDefinition(TOOL_ZIG_STRUCT_LAYOUT);
    const size = (options: Record<string, string>) => tool.compute(tool.createSpec(options), v).data!.display!.totalSize;
    expect(size({})).toBe(48);
    expect(size({ [OPTION_ZIG_CPU]: "x86_64_v3" })).toBe(64);
    // LLVM aligns a 32-byte vector to 32 whatever the CPU.
    expect(size({ [OPTION_BUILD_MODE]: "ReleaseFast" })).toBe(64);
    expect(size({ [OPTION_ZIG_TARGET]: "x86_64-macos-none" })).toBe(64);
    const code = zigToolDefinition(TOOL_ZIG_VERIFICATION_CODE);
    expect(code.compute(code.createSpec({ [OPTION_ZIG_CPU]: "x86_64_v3" }), v).fields!.find((f) => f.label === "Run")!.value).toContain("-mcpu=x86_64_v3");
  });

  it("says which std types it does not model, rather than laying out a stand-in", () => {
    const tool = zigToolDefinition(TOOL_ZIG_STRUCT_LAYOUT);
    const r = tool.compute(tool.createSpec(), 'const std = @import("std");\nconst E = enum { a, b };\nconst S = struct { s: std.EnumSet(E) };');
    expect(r.error).toMatch(/no declaration named 'EnumSet'/);
  });

  it("ZG004, ZG005 and ZG006", () => {
    expect(codes("const S = struct { a: Nope };")).toContain("ZG004");
    expect(codes("const P = packed struct { p: *u8 };")).toContain("ZG004");
    expect(codes("const S = struct { a: u8, comptime b: u8 = 1 };")).toContain("ZG005");
    expect(codes("const Unused = struct { x: u8 };\nconst S = struct { a: u8 };")).toContain("ZG006");
    expect(codes("const N = struct { x: u8 };\nconst S = struct { a: *N };")).not.toContain("ZG006");
  });

  it("generates a verification program for the declared or reordered struct", () => {
    const tool = zigToolDefinition(TOOL_ZIG_VERIFICATION_CODE);
    const code = "const S = extern struct { a: u8, b: u64, c: u8 };";
    const plain = tool.compute(tool.createSpec(), code).text!;
    expect(plain).toContain('@offsetOf(S, "b")');
    const opt = tool.compute(tool.createSpec({ [OPTION_MODE]: "optimized" }), code).text!;
    expect(opt).toContain("const SOptimized = extern struct {\n    b: u64,\n    a: u8,\n    c: u8,\n};");
    expect(opt).toContain("@sizeOf(SOptimized)");
    expect(tool.compute(tool.createSpec(), `${code}\npub fn main() void {}`).error).toMatch(/main/);
  });

  it("lays the definition out on every target", () => {
    const tool = zigToolDefinition(TOOL_ZIG_STRUCT_LAYOUT);
    const table = tool.variants!(tool.createSpec({ [OPTION_ZIG_TARGET]: "x86-linux-gnu" }), "const S = extern struct { a: u8, b: u64, c: []const u8 };");
    const row = (id: string) => table.rows.find((r) => r.options[OPTION_ZIG_TARGET] === id)!;
    expect(row("x86-linux-gnu").current).toBe(true);
    // The slice makes the extern struct invalid: the table says so on every target.
    expect(row("x86_64-linux-gnu").error).toMatch(/slices/);
    const ok = tool.variants!(tool.createSpec(), "const S = extern struct { a: u8, b: u64, c: u16 };");
    const size = (id: string) => ok.rows.find((r) => r.options[OPTION_ZIG_TARGET] === id)!.cells.size;
    expect(size("x86_64-linux-gnu")).toBe(24);
    expect(size("x86-linux-gnu")).toBe(16);
    expect(size("avr-freestanding-none")).toBe(11);
  });
});
