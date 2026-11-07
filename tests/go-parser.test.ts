import { describe, expect, it } from "vitest";
import { analyzeGo, formatGoStruct, formatGoType, lexGo, parseGo } from "@sp/core";
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
    const code = "package p\nconst (\n\tA uint8 = 1 << iota\n\tB\n\tC\n)\nconst M = 0xff &^ 0x0f\nconst N = ^-8\nconst U = 1_000\ntype S struct { a [A]byte; b [B]byte; c [C]byte; m [M]byte; n [N]byte; u [U]byte }";
    expect(analyzeGo(code, "amd64").result!.members.map((m) => m.size)).toEqual([1, 2, 4, 0xf0, 7, 1000]);
    // The repeated spec keeps the declared type: C is a uint8 constant.
    const file = parseGo(code);
    expect(file.consts.get("C")).toMatchObject({ iota: 2, type: { kind: "name", name: "uint8" } });
  });

  it("prints array lengths as gofmt does", () => {
    const fields = fieldTypes("package p\ntype S struct { a [N+1]byte; b [(1<<64-1)>>62]int; c [unsafe.Sizeof(T{})*2]T; d [0X1P3]int; e [(N)]int }");
    expect(fields).toEqual(["[N + 1]byte", "[(1<<64 - 1) >> 62]int", "[unsafe.Sizeof(T{}) * 2]T", "[0x1p3]int", "[(N)]int"]);
  });

  it("tells generic declarations from array types", () => {
    const file = parseGo("package p\nconst N = 4\ntype A [N]int\ntype G[T any, U comparable] struct { t T; u U }");
    expect(file.errors).toEqual([]);
    expect(file.types.get("A")!.typeParams).toEqual([]);
    expect(file.types.get("A")!.type).toMatchObject({ kind: "array", length: { kind: "ident", name: "N" } });
    expect(file.types.get("G")!.typeParams).toEqual(["T", "U"]);
  });

  it("lexes Go literals and inserts semicolons as the spec says", () => {
    const tokens = lexGo('x := `a\nb` + "c\\"d" + \'\\n\' /* one\nline */ 0x1p-2 1_000i').tokens;
    expect(tokens.map((t) => (t.inserted ? "\\n" : `${t.kind}:${t.value}`))).toEqual([
      "id:x", "punct::=", "str:`a\nb`", "punct:+", 'str:"c\\"d"', "punct:+", "char:'\\n'", "\\n", "float:0x1p-2", "imag:1_000i", "\\n",
    ]);
    expect(lexGo("a := 08").errors).toEqual([expect.objectContaining({ message: "Invalid number literal '08'." })]);
  });

  it("parses function declarations whatever their signatures", () => {
    const file = parseGo(
      "package p\nfunc (s *S) Get() interface{} { return nil }\nfunc New() map[string]struct{} { return nil }\nfunc F[T any](a, b T, xs ...[]int) (r struct{ v T }, err error) { return }\nfunc External(x int) int\ntype S struct { a int }",
    );
    expect(file.errors).toEqual([]);
    expect(file.order).toEqual(["S"]);
  });

  it("reports layout errors with their line", () => {
    const a = analyzeGo("package p\ntype S struct {\n\ta int\n\tb mystery.Thing\n}", "amd64");
    expect(a.errors).toEqual([expect.objectContaining({ line: 4 })]);
    const r = analyzeGo("package p\ntype S struct { next S }", "amd64");
    expect(r.errors[0]?.message).toMatch(/recursive/);
  });
});

describe("Go line ends", () => {
  // The spec: newlines are U+000A; a carriage return is white space, so it inserts no semicolon and
  // does not end a line comment (measured with go vet and gofmt, go1.27: "expected ';', found 'type'").
  it("reads a carriage return as a space", () => {
    expect(parseGo("package p\rtype S struct { a int8; b int64 }").errors[0]?.message).toMatch(/Expected a new line or ';'/);
    const file = parseGo("package p\n// note\rtype X int\ntype S struct {\r\n\ta int8\r\n\tb int64\r\n}\r\n");
    expect(file.errors).toEqual([]);
    expect([...file.types.keys()]).toEqual(["S"]);
    expect(analyzeGo("package p\ntype S struct {\n\ta int8;\r\tb int64\n}", "amd64").result?.totalSize).toBe(16);
  });
});
