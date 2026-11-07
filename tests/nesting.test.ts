import { describe, expect, it } from "vitest";
import { MAX_NESTING, NESTING_MESSAGE } from "@sp/core";
import { runLint } from "@sp/engine";
import type { AnyToolDefinition } from "@sp/engine";
import { loadTool } from "@sp/registry";

/**
 * Deep nesting, in every language: past MAX_NESTING levels each parser, evaluator and layout engine
 * reports an ordinary error (nesting.ts), and up to it nothing overflows the stack. For each way of
 * nesting, the deepest input accepted is found, and it is computed (layout, lint, option tags, the
 * "Across targets" table, the verification program) with half of the stack already in use: the
 * limit leaves every path well inside JavaScript's stack, also where a browser gives less of it.
 */

const r = (s: string, n: number) => s.repeat(n);
const seq = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n");
const CPP = { language: "c++17" };

interface Shape {
  /** The tool family's layout tool and verification tool run it. */
  tools: [string, string];
  options?: Record<string, string>;
  make: (n: number) => string;
}

const C = ["struct-layout", "verification-code"] as [string, string];
const GO = ["go-struct-layout", "go-verification-code"] as [string, string];
const RUST = ["rust-struct-layout", "rust-verification-code"] as [string, string];
const ZIG = ["zig-struct-layout", "zig-verification-code"] as [string, string];

const SHAPES: Record<string, Shape> = {
  // C and C++: declarations, constant expressions, the preprocessor and records laid out inside each other.
  "C nested anonymous structs": { tools: C, make: (n) => "struct S { " + r("struct { ", n) + "int x; " + r("} m; ", n) + "};" },
  "C nested tagged structs": { tools: C, make: (n) => "struct S { " + seq(n, (i) => `struct N${i} { `) + "int x; " + r("} m; ", n) + "};" },
  "C parentheses": { tools: C, make: (n) => "struct S { char a[" + r("(", n) + "1" + r(")", n) + "]; };" },
  "C unary operators": { tools: C, make: (n) => "struct S { char a[" + r("- ", 2 * n) + "1]; };" },
  "C casts": { tools: C, make: (n) => "struct S { char a[" + r("(int)", n) + "1]; };" },
  "C conditional operators": { tools: C, make: (n) => "struct S { char a[" + r("1 ? ", n) + "1" + r(" : 1", n) + "]; };" },
  "C sizeof of array types": { tools: C, make: (n) => "struct S { char a[" + r("sizeof(char[", n) + "1" + r("])", n) + "]; };" },
  "C parenthesized declarators": { tools: C, make: (n) => "struct S { int " + r("(*", n) + "x" + r(")", n) + "; };" },
  "C pointer declarators": { tools: C, make: (n) => "struct S { int " + r("*", n) + "x; };" },
  "C array declarators": { tools: C, make: (n) => "struct S { char x" + r("[1]", n) + "; };" },
  "C function pointer parameters": { tools: C, make: (n) => "struct S { void (*f)(" + r("void (*)(", n) + "void" + r(")", n) + "); };" },
  "C typeof": { tools: C, make: (n) => "struct S { " + r("__typeof__(", n) + "int" + r(")", n) + " x; };" },
  "C #if parentheses": { tools: C, make: (n) => "#if " + r("(", n) + "1" + r(")", n) + "\n#endif\nstruct S { int x; };" },
  "C #if conditional operators": { tools: C, make: (n) => "#if " + r("1 ? ", n) + "1" + r(" : 1", n) + "\n#endif\nstruct S { int x; };" },
  "C nested #if": { tools: C, make: (n) => r("#if 1\n", n) + "struct S { int x; };\n" + r("#endif\n", n) },
  "C macro invocations in arguments": { tools: C, make: (n) => "#define F(x) x\nstruct S { char a[" + r("F(", n) + "1" + r(")", n) + "]; };" },
  "C macros expanding to macros": { tools: C, make: (n) => "#define M0 1\n" + seq(n, (i) => `#define M${i} M${i - 1}`) + `\nstruct S { char a[M${n}]; };` },
  "C function-like macros expanding to macros": {
    tools: C,
    make: (n) => "#define F0(x) x\n" + seq(n, (i) => `#define F${i}(x) F${i - 1}(x)`) + `\nstruct S { char a[F${n}(1)]; };`,
  },
  "C typedef chain": { tools: C, make: (n) => "typedef int T0;\n" + seq(n, (i) => `typedef T${i - 1} T${i};`) + `\nstruct S { T${n} x; };` },
  "C typedef chain of arrays": { tools: C, make: (n) => "typedef char T0;\n" + seq(n, (i) => `typedef T${i - 1} T${i}[1];`) + `\nstruct S { T${n} x; };` },
  "C structs inside named structs": {
    tools: C,
    make: (n) => "struct A0 { int x; };\n" + seq(n, (i) => `struct A${i} { struct A${i - 1} a; };`) + `\nstruct S { struct A${n} a; };`,
  },
  "C structs pointing to each other": {
    tools: C,
    make: (n) => seq(n, (i) => `struct A${i} { struct A${i + 1} *p; };`) + `\nstruct S { struct A1 *p; };`,
  },
  "C++ nested classes": { tools: C, options: CPP, make: (n) => "struct S { " + seq(n, (i) => `struct N${i} { `) + "int x; " + r("}; ", n) + "int y; };" },
  "C++ base class chain": { tools: C, options: CPP, make: (n) => "struct A0 { int x; };\n" + seq(n, (i) => `struct A${i} : A${i - 1} { int y; };`) },
  "C++ virtual base class chain": { tools: C, options: CPP, make: (n) => "struct A0 { int x; };\n" + seq(n, (i) => `struct A${i} : virtual A${i - 1} { int y; };`) },
  "C++ polymorphic base chain, each measured": {
    tools: C,
    options: CPP,
    make: (n) =>
      "struct A0 { virtual void f(); };\n" + seq(n, (i) => `struct A${i} : A${i - 1} { int y; };\nstatic_assert(sizeof(A${i}) > 0, "");`),
  },
  "C++ namespaces": { tools: C, options: CPP, make: (n) => r("namespace a { ", n) + "struct S { int x; };" + r(" }", n) },

  // Go: types, constant expressions and declarations that use each other.
  "Go nested structs": { tools: GO, make: (n) => "package p\ntype S struct { a " + r("struct { a ", n) + "int" + r(" }", n) + " }" },
  "Go array types": { tools: GO, make: (n) => "package p\ntype S struct { a " + r("[1]", n) + "int }" },
  "Go pointer types": { tools: GO, make: (n) => "package p\ntype S struct { a " + r("*", n) + "int }" },
  "Go parenthesized types": { tools: GO, make: (n) => "package p\ntype S struct { a " + r("(", n) + "int" + r(")", n) + " }" },
  "Go function types": { tools: GO, make: (n) => "package p\ntype S struct { a " + r("func(", n) + "int" + r(")", n) + " }" },
  "Go map types": { tools: GO, make: (n) => "package p\ntype S struct { a " + r("map[int]", n) + "int }" },
  "Go generic instantiations": { tools: GO, make: (n) => "package p\ntype G[T any] struct { x T }\ntype S struct { a " + r("G[", n) + "int" + r("]", n) + " }" },
  "Go parenthesized constants": { tools: GO, make: (n) => "package p\nconst C = " + r("(", n) + "1" + r(")", n) + "\ntype S struct { a [C]int }" },
  "Go unary operators": { tools: GO, make: (n) => "package p\nconst C = " + r("+ ", n) + "1\ntype S struct { a [C]int }" },
  "Go len of composite literals": { tools: GO, make: (n) => "package p\ntype S struct { a [len([1]" + r("[1]", n) + "int{" + r("{", n) + "1" + r("}", n) + "})]int }" },
  "Go defined type chain": { tools: GO, make: (n) => "package p\ntype T0 int\n" + seq(n, (i) => `type T${i} T${i - 1}`) + `\ntype S struct { a T${n} }` },
  "Go array type chain": { tools: GO, make: (n) => "package p\ntype T0 int\n" + seq(n, (i) => `type T${i} [1]T${i - 1}`) + `\ntype S struct { a T${n} }` },
  "Go alias chain": { tools: GO, make: (n) => "package p\ntype T0 = int\n" + seq(n, (i) => `type T${i} = T${i - 1}`) + `\ntype S struct { a T${n} }` },
  "Go struct chain": { tools: GO, make: (n) => "package p\ntype A0 struct { x int }\n" + seq(n, (i) => `type A${i} struct { a A${i - 1} }`) + `\ntype S struct { a A${n} }` },
  "Go struct chain declared backwards": { tools: GO, make: (n) => "package p\ntype S struct { a A1 }\n" + seq(n, (i) => `type A${i} struct { a A${i + 1} }`) + `\ntype A${n + 1} struct { x int }` },
  "Go constant chain declared backwards": { tools: GO, make: (n) => "package p\ntype S struct { a [C1]int }\n" + seq(n, (i) => `const C${i} = C${i + 1}`) + `\nconst C${n + 1} = 1` },
  "Go structs pointing to each other": { tools: GO, make: (n) => "package p\n" + seq(n, (i) => `type A${i} struct { p *A${i + 1} }`) + "\ntype S struct { p *A1 }" },

  // Rust: types, constants, modules, use paths and items that use each other.
  "Rust tuples": { tools: RUST, make: (n) => "#[repr(C)] struct S { a: " + r("(", n) + "u8" + r(",)", n) + " }" },
  "Rust arrays": { tools: RUST, make: (n) => "#[repr(C)] struct S { a: " + r("[", n) + "u8" + r("; 1]", n) + " }" },
  "Rust pointers": { tools: RUST, make: (n) => "#[repr(C)] struct S { a: " + r("*const ", n) + "u8 }" },
  "Rust options": { tools: RUST, make: (n) => "struct S { a: " + r("Option<", n) + "u8" + r(">", n) + " }" },
  "Rust parenthesized constants": { tools: RUST, make: (n) => "const C: usize = " + r("(", n) + "1" + r(")", n) + ";\n#[repr(C)] struct S { a: [u8; C] }" },
  "Rust blocks in constants": { tools: RUST, make: (n) => "const C: usize = " + r("{ ", n) + "1" + r(" }", n) + ";\n#[repr(C)] struct S { a: [u8; C] }" },
  "Rust negations": { tools: RUST, make: (n) => "const C: i32 = " + r("- ", 2 * n) + "1;\n#[repr(C)] struct S { a: [u8; C as usize] }" },
  "Rust modules": { tools: RUST, make: (n) => r("mod m { ", n) + "pub struct Inner { a: u8 }" + r(" }", n) + "\n#[repr(C)] struct S { a: u8 }" },
  "Rust use paths": { tools: RUST, make: (n) => "use " + r("a::", n) + "B;\n#[repr(C)] struct S { a: u8 }" },
  "Rust alias chain": { tools: RUST, make: (n) => "type T0 = u8;\n" + seq(n, (i) => `type T${i} = T${i - 1};`) + `\n#[repr(C)] struct S { a: T${n} }` },
  "Rust array alias chain": { tools: RUST, make: (n) => "type T0 = u8;\n" + seq(n, (i) => `type T${i} = [T${i - 1}; 1];`) + `\n#[repr(C)] struct S { a: T${n} }` },
  "Rust struct chain": {
    tools: RUST,
    make: (n) => "#[repr(C)] struct A0 { x: u8 }\n" + seq(n, (i) => `#[repr(C)] struct A${i} { a: A${i - 1} }`) + `\n#[repr(C)] struct S { a: A${n} }`,
  },
  "Rust constant chain declared backwards": {
    tools: RUST,
    make: (n) => "#[repr(C)] struct S { a: [u8; C1] }\n" + seq(n, (i) => `const C${i}: usize = C${i + 1};`) + `\nconst C${n + 1}: usize = 1;`,
  },
  "Rust structs pointing to each other": {
    tools: RUST,
    make: (n) => seq(n, (i) => `#[repr(C)] struct A${i} { p: *const A${i + 1} }`) + `\n#[repr(C)] struct A${n + 1} { x: u8 }\n#[repr(C)] struct S { p: *const A1 }`,
  },

  // Zig: types, comptime expressions, function bodies and declarations that use each other.
  "Zig nested structs": { tools: ZIG, make: (n) => "const S = struct { a: " + r("struct { a: ", n) + "u8" + r(" }", n) + " };" },
  "Zig nested extern structs": { tools: ZIG, make: (n) => "const S = extern struct { a: " + r("extern struct { a: ", n) + "u8" + r(" }", n) + " };" },
  "Zig array types": { tools: ZIG, make: (n) => "const S = struct { a: " + r("[1]", n) + "u8 };" },
  "Zig optional types": { tools: ZIG, make: (n) => "const S = struct { a: " + r("?", n) + "u8 };" },
  "Zig pointer types": { tools: ZIG, make: (n) => "const S = struct { a: " + r("*const ", n) + "u8 };" },
  "Zig error unions": { tools: ZIG, make: (n) => "const S = struct { a: " + r("anyerror!", n) + "u8 };" },
  "Zig parentheses": { tools: ZIG, make: (n) => "const S = struct { a: [" + r("(", n) + "1" + r(")", n) + "]u8 };" },
  "Zig negations": { tools: ZIG, make: (n) => "const S = struct { a: [" + r("- ", 2 * n) + "1]u8 };" },
  "Zig @sizeOf of array types": { tools: ZIG, make: (n) => "const S = struct { a: [" + r("@sizeOf([", n) + "1" + r("]u8)", n) + "]u8 };" },
  "Zig calls of a type function": { tools: ZIG, make: (n) => "fn G(comptime T: type) type { return struct { x: T }; }\nconst S = struct { a: " + r("G(", n) + "u8" + r(")", n) + " };" },
  "Zig blocks in a type function": { tools: ZIG, make: (n) => "fn G() type { " + r("{ ", n) + "return u8;" + r(" }", n) + " }\nconst S = struct { a: G() };" },
  "Zig alias chain": { tools: ZIG, make: (n) => "const T0 = u8;\n" + seq(n, (i) => `const T${i} = T${i - 1};`) + `\nconst S = struct { a: T${n} };` },
  "Zig optional chain": { tools: ZIG, make: (n) => "const T0 = u8;\n" + seq(n, (i) => `const T${i} = ?T${i - 1};`) + `\nconst S = struct { a: T${n} };` },
  "Zig array chain declared backwards": { tools: ZIG, make: (n) => `const S = struct { a: T1 };\n` + seq(n, (i) => `const T${i} = [1]T${i + 1};`) + `\nconst T${n + 1} = u8;` },
  "Zig struct chain": { tools: ZIG, make: (n) => "const A0 = struct { x: u8 };\n" + seq(n, (i) => `const A${i} = struct { a: A${i - 1} };`) + `\nconst S = struct { a: A${n} };` },
  "Zig constant chain declared backwards": { tools: ZIG, make: (n) => `const S = struct { a: [C1]u8 };\n` + seq(n, (i) => `const C${i} = C${i + 1};`) + `\nconst C${n + 1} = 1;` },
  "Zig structs pointing to each other": { tools: ZIG, make: (n) => seq(n, (i) => `const A${i} = struct { p: *const A${i + 1} };`) + `\nconst A${n + 1} = struct { x: u8 };\nconst S = struct { p: *const A1 };` },
};

/** Runs `f` with `frames` stack frames already in use. */
function withFrames<T>(frames: number, f: () => T): T {
  const burn = (n: number): T => (n === 0 ? f() : burn(n - 1));
  return burn(frames);
}

/** The frames this stack holds, measured once (the only RangeError caught here: it is the measurement). */
const STACK_FRAMES = (() => {
  let lo = 1000;
  let hi = 1_000_000;
  while (hi - lo > 100) {
    const mid = (lo + hi) >> 1;
    try {
      withFrames(mid, () => 0);
      lo = mid;
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      hi = mid;
    }
  }
  return lo;
})();

const tools = new Map<string, AnyToolDefinition>();
async function tool(id: string): Promise<AnyToolDefinition> {
  if (!tools.has(id)) tools.set(id, await loadTool(id));
  return tools.get(id)!;
}

/** Everything the workbench runs on an input: its error, or "" when it computes. Throws what the tool throws. */
function run(t: AnyToolDefinition, options: Record<string, string>, input: string, everything = false): string {
  const spec = t.createSpec(options);
  const result = t.compute(spec, input);
  runLint(t.lintRules, { spec, input, result });
  t.variantTag?.(spec, input);
  if (everything) t.variants?.(spec, input);
  return result.error ?? "";
}

const nested = (error: string) => error === NESTING_MESSAGE;
/** Well past the limit, and as long as an input that does not nest is checked at. */
const LONG = 1000;

describe("deep nesting", () => {
  it("the nested-struct input that overflowed the stack is a nesting error", async () => {
    const input = "struct S { " + r("struct { ", 3000) + "int x; " + r("} m; ", 3000) + "};";
    const t = await tool("struct-layout");
    expect(run(t, {}, input)).toBe(NESTING_MESSAGE);
    expect(t.compute(t.createSpec({}), input).data).toBeDefined();
  });

  it("levels count as written: a struct inside each struct, a parenthesis, a macro invocation in an argument, a declarator", async () => {
    const t = await tool("struct-layout");
    const deepest = (make: (n: number) => string) => {
      let n = MAX_NESTING - 8;
      while (!nested(run(t, {}, make(n + 1)))) n += 1;
      return n;
    };
    // S's own body is the first level, inside which the members and their array sizes are.
    expect(deepest(SHAPES["C nested anonymous structs"]!.make)).toBe(MAX_NESTING - 1);
    expect(deepest(SHAPES["C parentheses"]!.make)).toBe(MAX_NESTING - 1);
    // The preprocessor's macro arguments, and a declaration's pointer, array and function declarators
    // (C++'s [implimits] minimum of 256 for those), are counted on their own.
    expect(deepest(SHAPES["C macro invocations in arguments"]!.make)).toBe(MAX_NESTING);
    expect(deepest(SHAPES["C pointer declarators"]!.make)).toBe(MAX_NESTING);
  }, 120_000);

  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`${name}: an error past the limit, and safe with half the stack in use up to it`, async () => {
      const [layout, verification] = await Promise.all(shape.tools.map(tool));
      const options = shape.options ?? {};
      // Between computations the worker answers vitest, which a long synchronous run would time out.
      const accepted = async (n: number) => {
        await new Promise((resolve) => setImmediate(resolve));
        return !nested(layout!.compute(layout!.createSpec(options), shape.make(n)).error ?? "");
      };
      // Each level of the input is at least one level of nesting, so 257 levels are always past it.
      const past = MAX_NESTING + 1;
      let deepest: number;
      if (await accepted(past)) {
        // A way of writing things that does not nest (a chain the engines walk without recursing):
        // it takes any length.
        expect(await accepted(LONG), `not nested at ${LONG} either`).toBe(true);
        deepest = LONG;
      } else {
        let lo = 0;
        let hi = past;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (await accepted(mid)) lo = mid;
          else hi = mid;
        }
        deepest = lo;
        // A level as written is one to three steps of an engine's recursion (a named type and the
        // struct it names, a generic type and its instantiation).
        expect(deepest).toBeGreaterThanOrEqual(MAX_NESTING / 4 - 1);
        expect(run(layout!, options, shape.make(LONG))).toBe(NESTING_MESSAGE);
      }
      const input = shape.make(deepest);
      await new Promise((resolve) => setImmediate(resolve));
      withFrames(Math.floor(STACK_FRAMES / 2), () => {
        expect(nested(run(layout!, options, input, true))).toBe(false);
        expect(nested(run(verification!, options, input))).toBe(false);
      });
    }, 300_000);
  }
});
