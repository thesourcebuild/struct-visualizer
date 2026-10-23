import { describe, expect, it } from "vitest";
import { CCodeGenerator, StructParser, analyzeStruct, resolvePlatform } from "@sp/core";
import type { PlatformSelection } from "@sp/core";

// Expected values are what GCC produces for x86-64 Linux (System V, LP64) unless noted.
const X64: PlatformSelection = { target: "intel-x64-amd", dataModel: "LP64", os: "linux" };

function layout(code: string, platform: PlatformSelection = X64) {
  const a = analyzeStruct(code, platform);
  return {
    errors: a.errors.map((e) => e.message),
    warnings: a.warnings.map((w) => w.message),
    size: a.result?.totalSize,
    align: a.result?.struct.alignment,
    offsets: Object.fromEntries((a.result?.members ?? []).map((m) => [m.member.name || `#${m.offset}`, m.offset])),
    analysis: a,
  };
}

describe("declarators", () => {
  it("parses multi-word integer types", () => {
    const r = layout("struct S { unsigned long long a; long long b; long double c; unsigned short d; signed char e; short int f; };");
    expect(r.errors).toEqual([]);
    expect(r.offsets).toEqual({ a: 0, b: 8, c: 16, d: 32, e: 34, f: 36 });
    expect(r.size).toBe(48);
  });

  it("distinguishes arrays of pointers from pointers to arrays", () => {
    const r = layout("struct S { char *names[4]; char (*row)[16]; const char *p; };");
    expect(r.errors).toEqual([]);
    expect(r.offsets).toEqual({ names: 0, row: 32, p: 40 });
    expect(r.size).toBe(48);
  });

  it("parses function pointers and several declarators per declaration", () => {
    const r = layout("struct S { int a, b, *c; void (*cb)(int, char *); char d; };");
    expect(r.offsets).toEqual({ a: 0, b: 4, c: 8, cb: 16, d: 24 });
    expect(r.size).toBe(32);
  });

  it("evaluates constant expressions and macros in array sizes", () => {
    expect(layout("#define N 4\n#define M (N * 2 + 1)\nstruct S { char buf[M]; int x; };").offsets).toEqual({ buf: 0, x: 12 });
    expect(layout("enum { LEN = 3 };\nstruct S { short v[LEN][2]; };").size).toBe(12);
    expect(layout("struct S { char buf[1 << 4]; };").size).toBe(16);
  });

  it("lays out a flexible array member with no size", () => {
    const r = layout("struct S { int n; double d[]; };");
    expect(r.offsets).toEqual({ n: 0, d: 8 });
    expect(r.size).toBe(8);
    expect(layout("struct S { int d[]; int n; };").errors[0]).toMatch(/must be the last member/);
  });

  it("reports errors with their line", () => {
    const a = analyzeStruct("struct S {\n  int a;\n  char b[N];\n};", X64);
    expect(a.errors[0]?.line).toBe(3);
    expect(a.errors[0]?.message).toMatch(/'N' is not a known constant/);
    expect(analyzeStruct("struct S {\n  int a\n  int b;\n};", X64).errors[0]?.message).toMatch(/Expected ';' after member 'a'/);
  });
});

describe("bit-fields", () => {
  it("handles unnamed and zero-width bit-fields", () => {
    const r = layout("struct S { int a : 3; int : 0; int b : 4; };");
    expect(r.errors).toEqual([]);
    expect(r.analysis.result!.members.map((m) => m.offset)).toEqual([0, 4, 4]);
    expect(r.size).toBe(8);
  });

  it("evaluates widths as constant expressions", () => {
    expect(layout("#define W 5\nstruct S { unsigned int f : W + 1; };").errors).toEqual([]);
  });
});

describe("packing and alignment", () => {
  it("applies __attribute__((packed)) before the name or after the brace", () => {
    for (const code of ["struct __attribute__((packed)) S { char a; int b; };", "struct S { char a; int b; } __attribute__((packed));"]) {
      const r = layout(code);
      expect(r.errors).toEqual([]);
      expect(r.offsets).toEqual({ a: 0, b: 1 });
      expect(r.size).toBe(5);
    }
  });

  it("applies #pragma pack with push/pop scoping", () => {
    const code = "#pragma pack(push, 2)\nstruct P { char a; int b; };\n#pragma pack(pop)\nstruct Q { char a; int b; struct P p; };";
    const parser = new StructParser(resolvePlatform(X64));
    parser.parse(code);
    expect(parser.getStruct("P")?.pragmaPack).toBe(2);
    expect(parser.getStruct("Q")?.pragmaPack).toBeUndefined();
    const r = layout(code);
    expect(r.offsets).toEqual({ a: 0, b: 4, p: 8 });
    expect(r.size).toBe(16);
  });

  it("caps alignment with #pragma pack(n) for n > 1", () => {
    const r = layout("#pragma pack(4)\nstruct S { char c; double d; };");
    expect(r.offsets).toEqual({ c: 0, d: 4 });
    expect(r.size).toBe(12);
  });

  it("ignores directives inside comments", () => {
    expect(layout("// #pragma pack(1)\n/* #pragma pack(1) */\nstruct S { char a; int b; };").size).toBe(8);
  });

  it("applies aligned and alignas to structs and members", () => {
    expect(layout("struct S { char a; } __attribute__((aligned(16)));").size).toBe(16);
    expect(layout("struct S { char a; int b __attribute__((aligned(16))); };").offsets).toEqual({ a: 0, b: 16 });
    expect(layout("struct S { char a; _Alignas(8) char b; };").offsets).toEqual({ a: 0, b: 8 });
    expect(layout("struct S { char a; alignas(double) char b; };").offsets).toEqual({ a: 0, b: 8 });
  });

  it("makes a packed enum as small as its values", () => {
    expect(layout("enum __attribute__((packed)) E { A, B };\nstruct S { enum E e; char c; };").size).toBe(2);
  });
});

describe("typedefs", () => {
  it("resolves scalar, pointer, array and function-pointer typedefs", () => {
    const r = layout(
      "typedef unsigned int u32x;\ntypedef char *str_t;\ntypedef int vec3[3];\ntypedef void (*cb_t)(int);\n" +
        "struct S { u32x a; char b; str_t s; vec3 v; cb_t cb; };",
    );
    expect(r.errors).toEqual([]);
    expect(r.offsets).toEqual({ a: 0, b: 4, s: 8, v: 16, cb: 32 });
    expect(r.size).toBe(40);
    const a = r.analysis.result!.members.find((m) => m.member.name === "a")!.member;
    expect(a.type).toBe("unsigned int");
    expect(a.declaredType).toBe("u32x");
  });

  it("supports typedef'd and tagged nested structs, including forward use", () => {
    const r = layout("typedef struct Point Point;\nstruct Point { int x, y; };\nstruct Line { Point a; Point b; };");
    expect(r.size).toBe(16);
  });
});

describe("preprocessor", () => {
  it("evaluates #if / #ifdef / #else and ignores #include", () => {
    const code = [
      "#include <stdint.h>",
      "#define WIDE 1",
      "#if WIDE",
      "typedef uint64_t word;",
      "#else",
      "typedef uint32_t word;",
      "#endif",
      "#ifndef NOT_DEFINED",
      "struct S { char c; word w; };",
      "#endif",
    ].join("\n");
    const r = layout(code);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.offsets).toEqual({ c: 0, w: 8 });
  });

  it("expands function-like macros in declarations", () => {
    const r = layout("#define ARR(name, n) char name[n]\n#define PAD(n) ARR(pad##n, n)\nstruct S { ARR(a, 3); PAD(5); int x; };");
    expect(r.errors).toEqual([]);
    expect(r.offsets).toEqual({ a: 0, pad5: 3, x: 8 });
  });

  it("reports a wrong argument count and an unterminated invocation", () => {
    expect(layout("#define F(a, b) a\nstruct S { int F(x); };").errors[0]).toMatch(/Macro 'F' takes 2 arguments, but 1 was given/);
    expect(layout("#define F(a) a\nstruct S { int F(x; };").errors[0]).toMatch(/Unterminated invocation of macro 'F'/);
  });

  it("says when a pragma has no effect", () => {
    expect(layout("#pragma GCC diagnostic ignored \"-Wpadded\"\nstruct S { int a; };").warnings[0]).toMatch(/#pragma GCC is ignored/);
  });

  it("does not warn about const, volatile, anonymous members or plain typedefs", () => {
    const r = layout("typedef int myint;\nstruct S { const myint a; volatile char b; union { int i; float f; }; };");
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.size).toBe(12);
  });
});

describe("C++ members", () => {
  it("skips methods, statics, access labels and nested types; warns about virtual", () => {
    const code = `struct S {
public:
  S();
  ~S();
  int get() const { return a; }
  static int count;
  struct Inner { int x; };
  virtual void f();
private:
  int a = 0;
  char b{};
};`;
    const r = layout(code);
    expect(r.errors).toEqual([]);
    expect(r.offsets).toEqual({ a: 0, b: 4 });
    expect(r.warnings[0]).toMatch(/vtable pointer is not included/);
  });
});

describe("optimized code generation", () => {
  it("emits code that parses back to the same optimized layout", () => {
    const code = "#pragma pack(4)\nstruct S { char a; double d; short s; int : 0; unsigned int f : 3; char tail[]; };";
    const a = analyzeStruct(code, X64);
    expect(a.errors).toEqual([]);
    const generated = CCodeGenerator.generateOptimizedCode(a.result!.struct, a.optimized!.struct);
    const again = analyzeStruct(generated, X64);
    expect(again.errors).toEqual([]);
    expect(again.result!.totalSize).toBe(a.optimized!.totalSize);
    expect(again.result!.members.map((m) => m.offset)).toEqual(a.optimized!.members.map((m) => m.offset));
  });
});

describe("constant expressions with types", () => {
  const I386: PlatformSelection = { target: "intel-x86", dataModel: "ILP32", os: "linux" };

  it("works out sizeof and offsetof for the target, from the definitions before them", () => {
    const code = "struct H { char c; long l; };\nstruct S { char pad[32 - sizeof(struct H)]; char at[offsetof(struct H, l)]; };";
    expect(layout(code).offsets).toEqual({ pad: 0, at: 16 });
    expect(layout(code, I386).offsets).toEqual({ pad: 0, at: 24 });
  });

  it("gives __alignof__ the i386 preferred alignment and _Alignof the member alignment", () => {
    const r = layout("struct S { char a[_Alignof(double)]; char b[__alignof__(double)]; };", I386);
    expect(r.offsets).toEqual({ a: 0, b: 4 });
    expect(r.size).toBe(12);
  });

  it("reports a type with no definition yet", () => {
    expect(layout("struct S { char a[sizeof(struct S)]; };").errors[0]).toMatch(/'struct S' is incomplete here/);
    expect(layout("struct S { char a[sizeof(struct Later)]; };\nstruct Later { int x; };").errors[0]).toMatch(/'struct Later' is incomplete here/);
  });

  it("reports a failed static assertion and one it cannot check", () => {
    expect(layout('_Static_assert(sizeof(long) == 4, "ILP32 only");\nstruct S { int a; };').errors[0]).toBe('Static assertion failed: "ILP32 only" (sizeof ( long ) == 4).');
    expect(layout("static_assert(std::is_pod<int>::value);\nstruct S { int a; };").warnings[0]).toMatch(/is not checked/);
  });

  it("rejects sizeof in #if, as the preprocessor does", () => {
    expect(layout("#if sizeof(int) == 4\n#endif\nstruct S { int a; };").errors[0]).toMatch(/'sizeof' needs types, which #if does not know/);
  });

  it("does not guess how a value converts to a type whose signedness the target decides", () => {
    expect(layout("struct S { char a[(char)200 > 0 ? 1 : 2]; };").errors[0]).toMatch(/depends on whether that type is signed/);
  });
});
