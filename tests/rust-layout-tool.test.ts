import { describe, expect, it } from "vitest";
import { rustToolDefinition } from "@sp/rust-layout/definition";
import { applyAllFixes, lint } from "@sp/rust-layout/lint";
import { OPTION_MODE, OPTION_RUST_TARGET, TOOL_RUST_STRUCT_LAYOUT, TOOL_RUST_VERIFICATION_CODE } from "@sp/rust-layout";
import { TOOL_MANIFESTS, loadTool } from "@sp/registry";

const createSpec = rustToolDefinition(TOOL_RUST_STRUCT_LAYOUT).createSpec;
const codes = (code: string) => lint(createSpec(), code).map((d) => d.code);

describe("Rust tool family", () => {
  it("is registered under the Rust family with Rust input, and every sample computes", async () => {
    const rust = TOOL_MANIFESTS.filter((m) => m.family === "rust");
    expect(rust.map((m) => m.id)).toEqual([TOOL_RUST_STRUCT_LAYOUT, TOOL_RUST_VERIFICATION_CODE]);
    expect(rust.every((m) => m.inputLanguage === "rust")).toBe(true);
    const tool = await loadTool(TOOL_RUST_STRUCT_LAYOUT);
    for (const sample of tool.samples!) {
      expect(tool.compute(tool.createSpec(), sample.input).error, sample.label).toBeUndefined();
    }
  });

  it("RS001 only for repr(C) structs, with a fix", () => {
    const c = "#[repr(C)]\nstruct S { a: u8, b: u64, c: u8 }";
    const d = lint(createSpec(), c).find((x) => x.code === "RS001")!;
    expect(d.message).toContain("24 → 16");
    expect(applyAllFixes(createSpec(), c).options[OPTION_MODE]).toBe("optimized");
    // rustc already reorders repr(Rust).
    expect(codes("struct S { a: u8, b: u64, c: u8 }")).not.toContain("RS001");
  });

  it("RS003 for packed fields that lose alignment", () => {
    expect(codes("#[repr(C, packed)]\nstruct S { a: u8, b: u32 }")).toContain("RS003");
    expect(codes("#[repr(C, packed)]\nstruct S { a: u8, b: [u8; 4] }")).not.toContain("RS003");
  });

  it("RS005 for a much larger enum variant", () => {
    expect(codes("enum E { Big([u8; 512]), Small(u8) }")).toContain("RS005");
    expect(codes("enum E { A([u8; 64]), B(u8) }")).not.toContain("RS005");
  });

  it("RS004 and RS006", () => {
    expect(codes("struct S { a: Nope }")).toContain("RS004");
    expect(codes("struct Unused { x: u8 }\nstruct S { a: u8 }")).toContain("RS006");
    expect(codes("struct N { x: u8 }\nstruct S { a: Box<N> }")).not.toContain("RS006");
  });

  it("generates a verification program for the declared or reordered struct", () => {
    const tool = rustToolDefinition(TOOL_RUST_VERIFICATION_CODE);
    const code = "#[repr(C)]\nstruct S { a: u8, b: u64, c: u8 }";
    const plain = tool.compute(tool.createSpec(), code).files![0]!.content;
    expect(plain).toContain("offset_of!(S, b)");
    const opt = tool.compute(tool.createSpec({ [OPTION_MODE]: "optimized" }), code).files![0]!.content;
    expect(opt).toContain("#[repr(C)]\nstruct SOptimized {\n    b: u64,\n    a: u8,\n    c: u8,\n}");
    expect(opt).toContain("size_of::<SOptimized>()");
    expect(tool.compute(tool.createSpec(), `${code}\nfn main() {}`).error).toMatch(/fn main/);
  });

  it("lays the definition out on every target", () => {
    const tool = rustToolDefinition(TOOL_RUST_STRUCT_LAYOUT);
    const table = tool.variants!(tool.createSpec({ [OPTION_RUST_TARGET]: "i686-unknown-linux-gnu" }), "struct S { a: u8, b: u64, c: &'static str }");
    const row = (id: string) => table.rows.find((r) => r.options[OPTION_RUST_TARGET] === id)!;
    expect(row("i686-unknown-linux-gnu").current).toBe(true);
    expect(row("i686-unknown-linux-gnu").cells.size).toBe(20);
    expect(row("x86_64-unknown-linux-gnu").cells.size).toBe(32);
    expect(row("avr-none").cells.size).toBe(13);
  });
});
