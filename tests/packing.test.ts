import { describe, expect, it } from "vitest";
import { runLint } from "@sp/engine";
import { applyPacking, packingSyntaxesFor } from "@sp/core";
import { layoutToolDefinition } from "@sp/layout/definition";
import { OPTION_DATA_MODEL, OPTION_MODE, OPTION_OS, OPTION_PACKING, OPTION_TARGET } from "@sp/layout";

/**
 * Packed mode: the source rewriting and the options around it. That a packed layout matches the
 * compilers is checked in cross-compiler.test.ts, which compiles applyPacking's output.
 */

describe("applyPacking", () => {
  it("wraps the whole source for #pragma pack", () => {
    expect(applyPacking("struct S { int a; };", "pragma")).toBe("#pragma pack(push, 1)\nstruct S { int a; };\n#pragma pack(pop)\n");
  });

  it("packs every definition, nested, anonymous and typedef'd ones included", () => {
    const code = "typedef struct { char a; } A;\nstruct S { struct { int x; } in; union U { char c; } u; };";
    expect(applyPacking(code, "attribute")).toBe(
      "typedef struct __attribute__((packed)) { char a; } A;\nstruct __attribute__((packed)) S { struct __attribute__((packed)) { int x; } in; union __attribute__((packed)) U { char c; } u; };",
    );
    expect(applyPacking(code, "keyword")).toBe(
      "typedef __packed struct { char a; } A;\n__packed struct S { __packed struct { int x; } in; __packed union U { char c; } u; };",
    );
  });

  it("leaves references, comments, strings and directives alone", () => {
    const code = [
      "#define MAKE struct M { int m; }",
      "struct T; /* struct C { } */ // struct D { }",
      'const char *s = "struct E { }";',
      "struct S { struct T *t; int n[sizeof(struct S *)]; };",
    ].join("\n");
    expect(applyPacking(code, "attribute")).toBe(code.replace("struct S {", "struct __attribute__((packed)) S {"));
  });

  it("finds the definition past attributes and alignas", () => {
    expect(applyPacking("struct __attribute__((aligned(8))) alignas(8) S { int a; };", "attribute")).toBe(
      "struct __attribute__((packed)) __attribute__((aligned(8))) alignas(8) S { int a; };",
    );
  });
});

describe("packing syntax per platform", () => {
  it("offers only what the compiler accepts", () => {
    expect(packingSyntaxesFor("linux", "LP64")).toEqual(["attribute", "pragma", "keyword"]);
    expect(packingSyntaxesFor("none", "ILP32")).toEqual(["attribute", "pragma", "keyword"]);
    expect(packingSyntaxesFor("windows", "LLP64")).toEqual(["pragma"]);
    expect(packingSyntaxesFor("none", "SDCC")).toEqual(["pragma"]);
    expect(packingSyntaxesFor("none", "C51")).toEqual(["pragma"]);
  });

  it("clamps a spec, such as an old share link, to an accepted syntax", () => {
    const tool = layoutToolDefinition("struct-layout");
    const windows = tool.createSpec({ [OPTION_TARGET]: "intel-x64-amd", [OPTION_OS]: "windows", [OPTION_PACKING]: "attribute" });
    expect(windows.options[OPTION_PACKING]).toBe("pragma");
    const sdcc = tool.createSpec({ [OPTION_TARGET]: "8051-8bit", [OPTION_DATA_MODEL]: "SDCC", [OPTION_PACKING]: "keyword" });
    expect(sdcc.options[OPTION_PACKING]).toBe("pragma");
    const linux = tool.createSpec({ [OPTION_PACKING]: "keyword" });
    expect(linux.options[OPTION_PACKING]).toBe("keyword");
    expect(tool.choicesFor?.(windows, OPTION_PACKING)?.map((c) => c.value)).toEqual(["pragma"]);
  });
});

describe("Packed mode", () => {
  const BITS = "struct S { char a:3; int :0; char b; };";

  it("lays out the struct the way the chosen syntax does", () => {
    const tool = layoutToolDefinition("struct-layout");
    // ARM GCC: the zero-width bit-field raises a packed struct's alignment to 4 under the
    // attribute, which #pragma pack(1) does not lower either (both measured).
    const arm = { [OPTION_TARGET]: "arm32", [OPTION_OS]: "linux", [OPTION_MODE]: "packed" };
    const attribute = tool.compute(tool.createSpec({ ...arm, [OPTION_PACKING]: "attribute" }), BITS).data!.display!;
    const pragma = tool.compute(tool.createSpec({ ...arm, [OPTION_PACKING]: "pragma" }), BITS).data!.display!;
    expect([attribute.totalSize, attribute.struct.alignment]).toEqual([8, 4]);
    expect([pragma.totalSize, pragma.struct.alignment]).toEqual([8, 4]);
    // MSVC (Windows): #pragma pack(1) caps the zero-width bit-field's alignment at 1.
    const msvc = tool.compute(tool.createSpec({ [OPTION_OS]: "windows", [OPTION_MODE]: "packed" }), BITS).data!.display!;
    expect([msvc.totalSize, msvc.struct.alignment]).toEqual([2, 1]);
  });

  it("verifies the source it laid out", () => {
    const verify = layoutToolDefinition("verification-code");
    for (const [packing, marker] of [
      ["attribute", "struct __attribute__((packed)) S"],
      ["pragma", "#pragma pack(push, 1)"],
      ["keyword", "__packed struct S"],
    ] as const) {
      const result = verify.compute(verify.createSpec({ [OPTION_MODE]: "packed", [OPTION_PACKING]: packing }), BITS);
      expect(result.files![0]!.content).toContain(marker);
    }
  });

  it("SP009 says __packed is not checked against Keil or IAR", () => {
    const tool = layoutToolDefinition("struct-layout");
    const codes = (packing: string) => {
      const spec = tool.createSpec({ [OPTION_MODE]: "packed", [OPTION_PACKING]: packing });
      const result = tool.compute(spec, BITS);
      return runLint(tool.lintRules, { spec, input: BITS, result }).map((d) => d.code);
    };
    expect(codes("keyword")).toContain("SP009");
    expect(codes("attribute")).not.toContain("SP009");
  });
});
