import { describe, expect, it } from "vitest";
import { analyzeGo, formatGoStruct, formatGoType, parseGo } from "@sp/core";
import type { GoType } from "@sp/core";

function fieldTypes(code: string): string[] {
  const file = parseGo(code);
  expect(file.errors).toEqual([]);
  const decl = file.types.get("S")!;
  return (decl.type as Extract<GoType, { kind: "struct" }>).fields.map((f) => formatGoType(f.type));
}

describe("Go parser", () => {
  it("prints types as gofmt would", () => {
    expect(
      fieldTypes(
        "package p\ntype S struct { r interface{ Read(p []byte) (n int, err error); Close() error }; f func(a, b int, p *T, xs ...string) (string, error); g func(m map[string][4]int) []byte; c <-chan struct{}; e interface{} }",
      ),
    ).toEqual([
      "interface{ Read(p []byte) (n int, err error); Close() error }",
      "func(a, b int, p *T, xs ...string) (string, error)",
      "func(m map[string][4]int) []byte",
      "<-chan struct{}",
      "interface{}",
    ]);
  });

  it("keeps struct tags and splits grouped names", () => {
    const file = parseGo('package p\ntype S struct {\n\tA, B int `json:"x"`\n\tC string\n}');
    const fields = (file.types.get("S")!.type as Extract<GoType, { kind: "struct" }>).fields;
    expect(fields.map((f) => [f.name, f.tag ?? null, f.line])).toEqual([
      ["A", '`json:"x"`', 3],
      ["B", '`json:"x"`', 3],
      ["C", null, 4],
    ]);
    // gofmt aligns a column only across consecutive rows that continue past it, so the
    // untagged `C string` row does not widen the type column.
    expect(formatGoStruct("S", fields)).toBe('type S struct {\n\tA int `json:"x"`\n\tB int `json:"x"`\n\tC string\n}');
    const mixed = parseGo('package p\ntype S struct {\n\tID uint32 `db:"id"`\n\tName string `db:"name"`\n\tok bool\n}');
    const mixedFields = (mixed.types.get("S")!.type as Extract<GoType, { kind: "struct" }>).fields;
    expect(formatGoStruct("S", mixedFields)).toBe(
      'type S struct {\n\tID   uint32 `db:"id"`\n\tName string `db:"name"`\n\tok   bool\n}',
    );
  });

  it("evaluates iota, typed constants and Go operators", () => {
    const file = parseGo("package p\nconst (\n\tA uint8 = 1 << iota\n\tB\n\tC\n)\nconst M = 0xff &^ 0x0f\nconst N = ^-8\nconst U = 1_000");
    expect(Object.fromEntries(file.consts)).toEqual({ A: 1, B: 2, C: 4, M: 0xf0, N: 7, U: 1000 });
  });

  it("tells generic declarations from array types", () => {
    const file = parseGo("package p\nconst N = 4\ntype A [N]int\ntype G[T any, U comparable] struct { t T; u U }");
    expect(file.types.get("A")!.typeParams).toEqual([]);
    expect(file.types.get("A")!.type).toMatchObject({ kind: "array", length: 4 });
    expect(file.types.get("G")!.typeParams).toEqual(["T", "U"]);
  });

  it("reports layout errors with their line", () => {
    const a = analyzeGo("package p\ntype S struct {\n\ta int\n\tb mystery.Thing\n}", "amd64");
    expect(a.errors).toEqual([expect.objectContaining({ line: 4 })]);
    const r = analyzeGo("package p\ntype S struct { next S }", "amd64");
    expect(r.errors[0]?.message).toMatch(/recursive/);
  });
});
