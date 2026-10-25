import { describe, expect, it } from "vitest";
import { runLint } from "@sp/engine";
import { layoutToolDefinition } from "@sp/layout/definition";
import { applyAllFixes, lint as lintLayout } from "@sp/layout/lint";
import {
  OPTION_DATA_MODEL,
  OPTION_ENUM_SIZE,
  OPTION_MODE,
  OPTION_OS,
  OPTION_TARGET,
  TAG_HAS_ENUM,
  TAG_OS_SELECTABLE,
} from "@sp/layout";

const tool = layoutToolDefinition("struct-layout");

const PADDED = `struct Example {
  char a;
  int b;
  char c;
  double d;
};`;

function lint(input: string, options: Record<string, string | number | boolean> = {}) {
  const spec = tool.createSpec(options);
  const result = tool.compute(spec, input);
  return { spec, result, diagnostics: runLint(tool.lintRules, { spec, input, result }) };
}

describe("struct-layout spec", () => {
  it("round-trips through the zod schema", () => {
    const spec = tool.createSpec({ [OPTION_TARGET]: "arm32" });
    expect(tool.specSchema.parse(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  });

  it("clamps the data model and OS to the target", () => {
    const spec = tool.createSpec({
      [OPTION_TARGET]: "microchip-8bit",
      [OPTION_DATA_MODEL]: "LP64",
      [OPTION_OS]: "windows",
    });
    expect(spec.options[OPTION_DATA_MODEL]).toBe("XC8");
    expect(spec.options[OPTION_OS]).toBe("none");
  });

  it("re-clamps when the target changes", () => {
    const spec = tool.createSpec();
    const next = tool.onOptionChange!(spec, OPTION_TARGET, "intel-x86");
    expect(next.options[OPTION_DATA_MODEL]).toBe("ILP32");
  });

  it("describes the platform and mode", () => {
    expect(tool.describe(tool.createSpec())).toMatch(/x64|x86-64|AMD64/i);
  });

  it("only lists data models valid for the target", () => {
    const spec = tool.createSpec({ [OPTION_TARGET]: "arm64" });
    const values = tool.choicesFor!(spec, OPTION_DATA_MODEL)!.map((c) => c.value);
    expect(values).toEqual(["LP64", "LLP64", "ILP64"]);
  });

  it("tags enum presence and OS selectability", () => {
    const spec = tool.createSpec();
    expect(tool.variantTag!(spec, "enum E { A }; struct S { enum E e; };")).toContain(TAG_HAS_ENUM);
    expect(tool.variantTag!(spec, PADDED)).not.toContain(TAG_HAS_ENUM);
    expect(tool.variantTag!(spec, PADDED)).toContain(TAG_OS_SELECTABLE);
    const bare = tool.createSpec({ [OPTION_TARGET]: "8051-8bit" });
    expect(tool.variantTag!(bare, PADDED)).not.toContain(TAG_OS_SELECTABLE);
  });
});

describe("struct-layout compute", () => {
  it("computes the canonical example on x64 Linux LP64", () => {
    const { result } = lint(PADDED);
    expect(result.data?.display?.totalSize).toBe(24);
    expect(result.data?.display?.totalPadding).toBe(10);
  });

  it("honours packed and optimized modes", () => {
    expect(lint(PADDED, { [OPTION_MODE]: "packed" }).result.data?.display?.totalSize).toBe(14);
    expect(lint(PADDED, { [OPTION_MODE]: "optimized" }).result.data?.display?.totalSize).toBe(16);
  });

  it("keeps i386 SysV 4-byte double alignment when an enum override is set", () => {
    const input = "enum E { A }; struct S { char c; double d; enum E e; };";
    const base = { [OPTION_TARGET]: "intel-x86", [OPTION_OS]: "linux" };
    const plain = lint(input, base).result.data!.display!;
    const overridden = lint(input, { ...base, [OPTION_ENUM_SIZE]: "4" }).result.data!.display!;
    expect(plain.members[1]!.offset).toBe(4);
    expect(overridden.members[1]!.offset).toBe(4);
  });

  it("lists every platform in the variants table and marks the current one", () => {
    const spec = tool.createSpec();
    const table = tool.variants!(spec, PADDED);
    expect(table.rows.length).toBe(43);
    const current = table.rows.filter((r) => r.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.options[OPTION_TARGET]).toBe("intel-x64-amd");
  });
});

describe("struct-layout lint", () => {
  const codes = (input: string, options = {}) => lint(input, options).diagnostics.map((d) => d.code);

  it("SP000 reports parse errors", () => {
    expect(codes("struct {")).toContain("SP000");
  });

  it("SP001 offers to show the optimized layout, and its fix removes the warning", () => {
    const { spec, diagnostics } = lint(PADDED);
    const sp001 = diagnostics.find((d) => d.code === "SP001");
    expect(sp001?.fix).toBeDefined();
    const fixed = sp001!.fix!.apply(spec);
    expect(fixed.options[OPTION_MODE]).toBe("optimized");
    const after = tool.compute(fixed, PADDED);
    expect(runLint(tool.lintRules, { spec: fixed, input: PADDED, result: after }).map((d) => d.code))
      .not.toContain("SP001");
  });

  it("applies #pragma pack instead of warning about it", () => {
    const { result, diagnostics } = lint(`#pragma pack(1)\n${PADDED}`);
    expect(result.data?.display?.totalSize).toBe(14);
    expect(diagnostics.map((d) => d.code)).not.toContain("SP008");
  });

  it("SP004 warns only where bit-fields are not checked against the compiler", () => {
    const bits = "struct B { unsigned int a:3; unsigned int b:5; };";
    expect(codes(bits)).not.toContain("SP004");
    const xc16 = lint(bits, { [OPTION_TARGET]: "microchip-16bit", [OPTION_DATA_MODEL]: "XC16", [OPTION_OS]: "none" });
    expect(xc16.diagnostics.find((d) => d.code === "SP004")?.message).toBe(
      "Bit-field positions here are not checked against Microchip XC16.",
    );
  });

  it("SP005 reports the real size on the other OS", () => {
    // i386: Linux aligns double to 4 (20 bytes), Windows to 8 (24 bytes).
    const sp005 = lint(PADDED, { [OPTION_TARGET]: "intel-x86" }).diagnostics.find((d) => d.code === "SP005");
    expect(sp005?.message).toBe("On Windows this struct is 24 bytes, not 20.");
    expect(codes(PADDED, { [OPTION_TARGET]: "arm64" })).not.toContain("SP005");
  });

  it("SP005 stays quiet when both OSes agree, and reports alignment-only differences", () => {
    // Same on x86-64 Linux and Windows.
    expect(codes(PADDED)).not.toContain("SP005");
    // i386: 8 bytes either way, but 4-aligned on Linux and 8-aligned on Windows.
    const sp005 = lint("struct D { double d; };", { [OPTION_TARGET]: "intel-x86" }).diagnostics.find(
      (d) => d.code === "SP005",
    );
    expect(sp005?.message).toContain("8-byte aligned, not 4");
  });

  it("SP006 names definitions that are not laid out", () => {
    const { diagnostics } = lint("struct A { int x; }; struct B { char y; };");
    const sp006 = diagnostics.find((d) => d.code === "SP006");
    expect(sp006?.message).toContain("'struct A'");
  });

  it("SP006 stays quiet when earlier definitions are used as nested members", () => {
    const input = `struct Coordinate { int x; int y; };
union Value { int intVal; float floatVal; double doubleVal; };
struct DataPacket { struct Coordinate location; union Value data; char flag; };`;
    expect(codes(input)).not.toContain("SP006");
  });

  it("SP006 counts structs used through pointers and typedef names as used", () => {
    const input = `struct Ctx { int id; };
typedef struct Node Node;
struct Node { int v; };
struct S { struct Ctx *ctx; Node *next; void (*cb)(struct Ctx *); };`;
    expect(codes(input)).not.toContain("SP006");
  });

  it("SP006 ignores anonymous inline types", () => {
    expect(codes("struct S { struct { char a; int b; } inner; union { int i; float f; } u; };")).not.toContain(
      "SP006",
    );
  });

  it("produces no diagnostics for plain enums; the default size is in the Enum options", () => {
    expect(codes("enum E { A }; struct S { enum E e; };")).toEqual([]);
    const spec = tool.createSpec({ [OPTION_TARGET]: "microchip-8bit" });
    const labels = tool.choicesFor!(spec, OPTION_ENUM_SIZE)!.map((c) => c.label);
    expect(labels[0]).toMatch(/^Data model default \(\d bytes?\)$/);
  });

  it("orders errors before warnings before info", () => {
    const order = { error: 0, warning: 1, info: 2 } as const;
    const levels = lint(`#pragma foo\nstruct A { int x; };\n${PADDED}`, { [OPTION_TARGET]: "intel-x86" })
      .diagnostics.map((d) => order[d.level]);
    expect(levels.length).toBeGreaterThan(2);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
  });
});

describe("struct-layout lint/run", () => {
  it("lint() matches the workbench's lint pass", () => {
    const spec = tool.createSpec();
    expect(lintLayout(spec, PADDED).map((d) => d.code)).toEqual(
      lint(PADDED).diagnostics.map((d) => d.code),
    );
  });

  it("applyAllFixes applies warning fixes once and ignores info suggestions", () => {
    // SP001 (warning) switches to the optimized layout. SP005 (info) offers the Windows layout,
    // which must not be applied automatically.
    const fixed = applyAllFixes(tool.createSpec({ [OPTION_TARGET]: "intel-x86" }), PADDED);
    expect(fixed.options[OPTION_MODE]).toBe("optimized");
    expect(fixed.options[OPTION_OS]).toBe("linux");
  });
});

describe("verification-code tool", () => {
  const verify = layoutToolDefinition("verification-code");

  it("emits a downloadable C program", () => {
    const result = verify.compute(verify.createSpec(), PADDED);
    expect(result.files?.[0]?.filename).toBe("Example_verify.c");
    expect(result.files![0]!.content).toContain("offsetof(");
  });

  it("emits C++ when asked, with the compiler's -std", () => {
    const result = verify.compute(verify.createSpec({ language: "c++20" }), PADDED);
    expect(result.files?.[0]?.filename).toBe("Example_verify.cpp");
    expect(result.files![0]!.content).toContain("#include <iostream>");
    expect(result.fields?.find((f) => f.label === "Compile")?.value).toContain("-std=c++20");
  });
});

describe("Bindings tool", () => {
  const bindings = layoutToolDefinition("bindings");
  const code = "struct Example { char a; int b; char c; double d; };";
  const compute = (language: string, options: Record<string, string> = {}) => bindings.compute(bindings.createSpec({ bindingLanguage: language, ...options }), code);

  it("writes the binding, and the example where the language keeps it apart", () => {
    const files = (language: string) => compute(language).files!.map((f) => f.filename);
    expect(files("rust")).toEqual(["Example.rs"]);
    expect(files("zig")).toEqual(["Example.zig"]);
    expect(files("python-struct")).toEqual(["Example.py"]);
    expect(files("go")).toEqual(["Example.go", "Example_example_test.go"]);
    expect(files("csharp")).toEqual(["Example.cs", "ExampleRoundTrip.cs"]);
  });

  it("says how to build it, read and write its bytes, and run its round trip", () => {
    const go = compute("go").working!;
    expect(go).toContain("GOARCH=amd64");
    expect(go).toContain("ReadExample(r)");
    expect(go).toContain("go test");
    expect(compute("rust").working!.split("\n")).toHaveLength(3);
    // A bare-metal target has no machine to run a test on, and its binding no test.
    const bare = compute("rust", { target: "arm32", dataModel: "ILP32", os: "none" });
    expect(bare.working!.split("\n")).toHaveLength(2);
    expect(bare.files![0]!.content).not.toContain("#[cfg(test)]");
    expect(compute("rust").files![0]!.content).toContain("#[cfg(test)]");
  });
});
