import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GO_TARGETS, analyzeGo, generateGoOptimizedCode, generateGoVerificationCode, goExamples, parseGo } from "@sp/core";
import type { CalculationResult, GoType } from "@sp/core";
import { References, digest, useReferences } from "./support/references";

/**
 * Ground truth for Go: tests/fixtures/golayout type-checks each case with go/types and
 * types.SizesFor("gc", arch), which implements the gc compiler's layout rules, for every
 * architecture. The calculator must agree on size, alignment and every field offset, and reject
 * what go/types rejects.
 *
 * The suggested order is checked against the real fieldalignment analyzer
 * (golang.org/x/tools v0.49.0, built from tests/fixtures/golayout/fieldalignment), run the way a
 * user runs it: `fieldalignment -json ./...` with GOARCH set, on every architecture.
 *
 * The helpers are built and run once for all cases (asynchronously: it takes a while, and a
 * blocked worker times out vitest's RPC).
 *
 * Without Go, the layouts are checked against go/types' recorded answers (tests/references/go.json),
 * and the orders against fieldalignment's.
 */
function hasGo(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A struct of `n` fields cycling through types with many equal sort keys (pdqsort beyond 12). */
function manyFields(n: number, step: number): string {
  const types = ["int64", "byte", "string", "*int", "int32", "[2]int16", "struct{}", "bool", "[]byte", "uint64", "uint16", "any", "complex64", "[0]int64", "float64"];
  return `package p\ntype S struct {\n${Array.from({ length: n }, (_, i) => `\tf${i} ${types[(i * step) % types.length]}`).join("\n")}\n}`;
}

const CASES: Record<string, string> = {
  ...Object.fromEntries(goExamples.map((e) => [e.name, e.code])),
  // A carriage return is white space: it ends no line, so a line comment runs on past it.
  "carriage returns as white space": "package p\n// note\rtype X int\ntype S struct {\r\n\ta int8;\r\tb int64\r\n}\r\n",
  "complex numbers": "package p\ntype S struct { a bool; c64 complex64; b bool; c128 complex128; f float32 }",
  "trailing empty struct": "package p\ntype S struct { a int32; b struct{} }",
  "leading empty struct": "package p\ntype S struct { b struct{}; a int32 }",
  "only zero-size fields": "package p\ntype S struct { a struct{}; b [0]int64 }",
  "trailing [0]int64": "package p\ntype S struct { a byte; z [0]int64 }",
  "array of structs": "package p\ntype P struct { x int16; y byte }\ntype S struct { ps [3]P; tail byte }",
  "named types and aliases": "package p\ntype ID int64\ntype B = byte\ntype Name string\ntype S struct { b B; id ID; n Name; f bool }",
  "iota array length": "package p\nconst (\n\tA = iota\n\tB\n\tC\n\tN\n)\ntype S struct { flags [N]bool; v uint32; k [C * 2]uint16 }",
  "multiple names per line": "package p\ntype S struct { a, b int8; c, d int64; e, f bool }",
  "unsafe and uintptr": 'package p\nimport "unsafe"\ntype S struct { flag bool; p unsafe.Pointer; u uintptr; b byte }',
  "channels and funcs": "package p\ntype S struct { a bool; r <-chan int; s chan<- string; f func(int) (string, error); g func() }",
  "sync types": 'package p\nimport "sync"\ntype S struct { a bool; mu sync.Mutex; rw sync.RWMutex; once sync.Once; wg sync.WaitGroup; b bool }',
  "atomic types": 'package p\nimport "sync/atomic"\ntype T struct{ x int }\ntype S struct { flag bool; i32 atomic.Int32; i64 atomic.Int64; u64 atomic.Uint64; ok atomic.Bool; v atomic.Value; p atomic.Pointer[T]; up atomic.Uintptr; u32 atomic.Uint32 }',
  "std containers": 'package p\nimport (\n\t"bytes"\n\t"strings"\n\t"reflect"\n)\ntype S struct { a bool; sb strings.Builder; buf bytes.Buffer; v reflect.Value; t reflect.Type }',
  "time and net": 'package p\nimport (\n\t"net"\n\t"net/netip"\n\t"time"\n)\ntype S struct { ok bool; at time.Time; d time.Duration; ip net.IP; addr netip.Addr; m time.Month }',
  "slog logger": 'package p\nimport "log/slog"\ntype S struct { on bool; log slog.Logger; lp *slog.Logger }',
  "embedded pointer and generic": "package p\ntype Box[T any] struct { v T; set bool }\ntype Inner struct { n int16 }\ntype S struct { *Inner; Box[int64]; tail bool }",
  "nested anonymous structs": "package p\ntype S struct { a byte; in struct { b int64; c struct { d byte; e int16 } }; f byte }",
  "struct tags": 'package p\ntype S struct {\n\tName string `json:"name,omitempty"`\n\tAge  uint8  `json:"age"`\n\tID   int64 "db:\\"id\\""\n}',
  "blank fields": "package p\ntype S struct { a byte; _ [3]byte; b uint32; _ int16 }",
  "interfaces": 'package p\nimport "fmt"\ntype S struct { a bool; e error; s fmt.Stringer; x any; y interface{}; z interface{ M() } }',

  // Generics: type arguments are resolved where they are written.
  "nested generic instantiation": "package p\ntype Box[T any] struct { v T; ok bool }\ntype Pair[A, B any] struct { a Box[A]; b B }\ntype S struct { p Pair[int8, int64]; t byte }",
  "generic instantiated with a type parameter": "package p\ntype Box[T any] struct { v T; ok bool }\ntype W[T any] struct { b Box[T]; x byte }\ntype S struct { w W[int64]; m W[Box[int16]]; c byte }",
  "generic alias": "package p\ntype P[T any] struct { a T; b byte }\ntype Q[T any] = P[T]\ntype S struct { q Q[int32]; r Q[Q[int8]]; c byte }",

  // Function declarations are skipped whole, whatever their result types.
  "funcs whose results have braces": "package p\ntype S struct { a byte; b int64; c byte }\nfunc (s *S) Get() interface{} { return nil }\nfunc New() map[string]struct{} { return map[string]struct{}{} }\nfunc F() struct{ a int } { return struct{ a int }{} }\nfunc G[T any](x T) (r struct{ v T }) {\n\tr.v = x\n\treturn\n}",
  "raw string tag over two lines": 'package p\ntype S struct {\n\tA byte `a:"1"\nb:"2"`\n\tB int64 "c:\\"3\\""\n\tC rune\n}',

  // Constants, with Go's constant semantics.
  "constants beyond 64 bits": "package p\nconst N = (1<<64 - 1) >> 62\nconst Big = 1 << 100\ntype S struct { a [N]byte; b [Big >> 98]int16; c [Big / (Big >> 1)]bool }",
  "untyped float constants": "package p\nconst N = 4.0\nconst M = 10.0/4*2\nconst H = 0x1p3\ntype S struct { a [N]byte; b [M]byte; c [H]int16; d [1e1]bool; e ['a' - 'Z']byte }",
  "len and unsafe constants": 'package p\nimport "unsafe"\ntype T struct { a byte; b int64; c string }\nvar t T\nconst name = "hello"\ntype S struct { a [len(name)]byte; b [unsafe.Sizeof(uintptr(0))]byte; c [unsafe.Alignof(t.b)]byte; d [unsafe.Offsetof(T{}.c)]byte; e [unsafe.Sizeof(t)]bool; f [len([3]int{})]byte; g [unsafe.Sizeof(*(*T)(nil))]byte }',
  "typed constants, iota and conversions": "package p\ntype Kind uint8\nconst (\n\tK0 Kind = iota * 2\n\tK1\n\tK2\n)\nconst Mask = ^uint8(0) >> 4\nconst Neg = -int8(-128 + 1)\ntype S struct { a [K2]byte; b [Mask]byte; c [Neg]bool; d [min(9, 3.0, 5)]byte; e [max(2, 'b'-'a')]int8; f [real(3 + 4i)]byte; g [len(string(rune(65)))]byte; h [int(float32(0.5) * 4)]byte }",
  "word-size constants": "package p\nconst U = ^uint(0)\ntype S struct { a [U >> 61]byte; b [U >> 31 & 3]int32; c bool }",
  "int constants that need 64 bits": "package p\nconst N int = 1 << 40\ntype S struct { a [N >> 38]byte; b uint64 }",

  // Package scope shadows the universe.
  "a declared type named like a predeclared one": "package p\ntype int32 int64\ntype float64 = string\ntype S struct { a byte; b int32; c float64; d rune }",

  // Orders fieldalignment chooses (its own sizes, and sort.Slice's unstable pdqsort).
  "fieldalignment: complex64": "package p\ntype S struct { a int32; c complex64; d int64; e byte }",
  "fieldalignment: complex64 and atomics": 'package p\nimport "sync/atomic"\ntype S struct { a bool; x atomic.Int64; c complex64; b bool; s string; w atomic.Uint64; f float32 }',
  "fieldalignment: 13 fields": manyFields(13, 1),
  "fieldalignment: 30 fields": manyFields(30, 7),
  "fieldalignment: 64 fields": manyFields(64, 4),
};

/** Code go/types rejects: the calculator must reject it too, on every architecture. */
const REJECTED: Record<string, string> = {
  "carriage return as a line end": "package p\rtype S struct { a int8; b int64 }",
  "typed constant overflow": "package p\nconst N uint8 = 255\ntype S struct { a [N + 1]byte }",
  "instantiation cycle": "package p\ntype B[T any] struct { b *B[[2]T] }\ntype S struct { x B[int] }",
  "generic containing itself": "package p\ntype B[T any] struct { v T; b B[T] }\ntype S struct { x B[int] }",
  "float typed array length": "package p\nconst F float64 = 4\ntype S struct { a [F]byte }",
  "truncated array length": "package p\ntype S struct { a [2.5]byte }",
  "negative array length": "package p\nconst N = -1\ntype S struct { a [N]byte }",
  "division by zero": "package p\ntype S struct { a [1 / 0]byte }",
  "mismatched constant types": "package p\nconst A int8 = 1\nconst B int16 = 1\ntype S struct { a [A + B]byte }",
  "constant initialization cycle": "package p\nconst A = B\nconst B = A + 1\ntype S struct { a [A]byte }",
  "shift count too large": "package p\ntype S struct { a [1 << 1100 >> 1099]byte }",
};

interface HelperLayout {
  size: number;
  align: number;
  fields: Array<{ name: string; offset: number; size: number }>;
}

type ArchAnswer = HelperLayout | { error: string };
type HelperOutput = { name: string; archs: Record<string, ArchAnswer> } | { error: string };

/** fieldalignment's diagnostic for the root struct on one architecture: its message and order. */
type FieldAlignmentAnswer = { message: string | null; order: string[] | null };

const run = promisify(execFile);
const GC_TARGETS = GO_TARGETS.filter((t) => t.compiler === "gc");
const exe = process.platform === "win32" ? ".exe" : "";

function shape(result: CalculationResult) {
  return {
    size: result.totalSize,
    align: result.struct.alignment,
    fields: result.members.map((m) => ({ name: m.member.name, offset: m.offset, size: m.size })),
  };
}

/** Parses the verification program's output into the helper's shape. */
function parseProgramOutput(out: string): HelperLayout {
  const head = /size (\d+), align (\d+)/.exec(out)!;
  return {
    size: Number(head[1]),
    align: Number(head[2]),
    fields: [...out.matchAll(/^\s+(\S+)\s+offset:\s+(\d+)\s+size:\s+(\d+)/gm)].map((m) => ({
      name: m[1]!,
      offset: Number(m[2]),
      size: Number(m[3]),
    })),
  };
}

/** The field names of a struct type as fieldalignment's fix prints it. */
function fixOrder(structText: string): string[] {
  const file = parseGo(`package p\ntype T ${structText}`);
  expect(file.errors).toEqual([]);
  return (file.types.get("T")!.type as Extract<GoType, { kind: "struct" }>).fields.map((f) => f.name);
}

/** go/types' answer for the reordered code the tool generates, which holds for that code only. */
type ForCode = HelperLayout & { code: string };

const refs = new References<{ name: string; archs: Record<string, ArchAnswer> } | ForCode | FieldAlignmentAnswer>("go");
afterAll(() => refs.save());
const compile = hasGo() && !useReferences;
const goos = (arch: string) => (arch === "wasm" ? "wasip1" : "linux");

describe(`Go layouts match go/types (gc) for every architecture${compile ? "" : " (recorded answers)"}`, () => {
  const entries = Object.entries(CASES);
  const rejected = Object.entries(REJECTED);
  /** go/types' answer for each case as written, then for each rejected case. */
  let truths: HelperOutput[] = [];
  let rejectedTruths: HelperOutput[] = [];
  /** go/types' answer for each distinct reordered source (the order can differ per arch). */
  const optimizedTruths = new Map<string, HelperOutput>();
  /** fieldalignment's answers by case label and arch, when it could be built. */
  let fieldalignment: Map<string, Record<string, FieldAlignmentAnswer>> | undefined;
  let dir = "";

  const optimizedSource = (code: string, targetId: string) => {
    const a = analyzeGo(code, targetId);
    return generateGoOptimizedCode(code, a.definition!.name, a.optimizedFields);
  };
  const accepted = (code: string, targetId: string) => analyzeGo(code, targetId).errors.length === 0;

  /** Runs the real fieldalignment over every case, on every architecture. */
  const runFieldAlignment = async (): Promise<Map<string, Record<string, FieldAlignmentAnswer>> | undefined> => {
    const bin = join(dir, `fieldalignment${exe}`);
    try {
      await run("go", ["build", "-o", bin, "golang.org/x/tools/go/analysis/passes/fieldalignment/cmd/fieldalignment"], {
        cwd: resolve(__dirname, "fixtures/golayout/fieldalignment"),
        env: { ...process.env, GO111MODULE: "on" },
      });
    } catch {
      // Not buildable here (no network for golang.org/x/tools): the recorded answers stand.
      return undefined;
    }
    const mod = join(dir, "fieldalignment-cases");
    mkdirSync(mod);
    writeFileSync(join(mod, "go.mod"), "module spfa\n\ngo 1.25\n");
    entries.forEach(([, code], index) => {
      mkdirSync(join(mod, `case${index}`));
      writeFileSync(join(mod, `case${index}`, "case.go"), code);
    });
    const answers = new Map<string, Record<string, FieldAlignmentAnswer>>();
    await Promise.all(
      GC_TARGETS.map(async (t) => {
        const env = { ...process.env, GO111MODULE: "on", GOOS: goos(t.id), GOARCH: t.id, CGO_ENABLED: "0", GOFLAGS: "" };
        let stdout: string;
        try {
          ({ stdout } = await run(bin, ["-json", "./..."], { cwd: mod, env, maxBuffer: 256 * 1024 * 1024 }));
        } catch (err) {
          stdout = (err as { stdout?: string }).stdout ?? "";
        }
        const report = JSON.parse(stdout) as Record<string, { fieldalignment?: Array<{ message: string; suggested_fixes: Array<{ edits: Array<{ new: string }> }> }> }>;
        entries.forEach(([label], index) => {
          const truth = truths[index]!;
          if ("error" in truth || "error" in truth.archs[t.id]!) return;
          const diag = report[`spfa/case${index}`]?.fieldalignment?.find((d) => d.message.startsWith(`${truth.name} has `));
          const answer: FieldAlignmentAnswer = diag
            ? { message: diag.message, order: fixOrder(diag.suggested_fixes[0]!.edits[0]!.new) }
            : { message: null, order: null };
          answers.set(label, { ...answers.get(label), [t.id]: answer });
        });
      }),
    );
    return answers;
  };

  beforeAll(async () => {
    if (!compile) return;
    dir = mkdtempSync(join(tmpdir(), "sp-go-"));
    const helper = join(dir, `golayout${exe}`);
    await run("go", ["build", "-o", helper, "main.go"], {
      cwd: resolve(__dirname, "fixtures/golayout"),
      env: { ...process.env, GO111MODULE: "off" },
    });

    const sources = entries.map(([, code]) => code);
    const rejectedSources = rejected.map(([, code]) => code);
    const optimized = [
      ...new Set(entries.flatMap(([, code]) => GC_TARGETS.filter((t) => accepted(code, t.id)).map((t) => optimizedSource(code, t.id)))),
    ];
    const files = [...sources, ...rejectedSources, ...optimized].map((code, index) => {
      const src = join(dir, `case${index}.go`);
      writeFileSync(src, code);
      return src;
    });
    const { stdout } = await run(helper, files, { maxBuffer: 256 * 1024 * 1024 });
    const all = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as HelperOutput);
    truths = all.slice(0, sources.length);
    rejectedTruths = all.slice(sources.length, sources.length + rejectedSources.length);
    optimized.forEach((code, i) => optimizedTruths.set(code, all[sources.length + rejectedSources.length + i]!));
    fieldalignment = await runFieldAlignment();
  }, 1_200_000);

  entries.forEach(([label, code], index) => {
    refs.declare(label);
    for (const target of GC_TARGETS) {
      refs.declare(`${label} | reordered for ${target.id}`);
      refs.declare(`${label} | fieldalignment on ${target.id}`);
    }
    it(label, () => {
      const now = compile ? truths[index]! : undefined;
      const answer = refs.answer(label, now && ("error" in now ? { rejected: now.error } : { layout: now }));
      if ("rejected" in answer) throw new Error(`go/types rejected the case: ${answer.rejected}`);
      if (!("layout" in answer)) throw new Error("go/types gave no layout");
      const truth = answer.layout as { name: string; archs: Record<string, ArchAnswer> };

      for (const target of GC_TARGETS) {
        const analysis = analyzeGo(code, target.id);
        const archTruth = truth.archs[target.id]!;
        if ("error" in archTruth) {
          // go/types rejects the code on this architecture only.
          expect(analysis.errors.map((e) => e.message), `${target.id}: go/types says ${archTruth.error}`).not.toEqual([]);
          continue;
        }
        expect(analysis.errors.map((e) => e.message), target.id).toEqual([]);
        const result = analysis.result!;
        expect(result.struct.name).toBe(truth.name);
        expect({ arch: target.id, ...shape(result) }).toEqual({ arch: target.id, ...archTruth });

        // The reordered struct, as generated, compiles to the layout the calculator predicts.
        const source = optimizedSource(code, target.id);
        const opt = compile ? optimizedTruths.get(source)! : undefined;
        const optArch = opt && !("error" in opt) ? opt.archs[target.id]! : undefined;
        const optAnswer = refs.answer(
          `${label} | reordered for ${target.id}`,
          opt &&
            ("error" in opt ? { rejected: opt.error } : "error" in optArch! ? { rejected: optArch.error } : { layout: { code: digest(source), ...optArch! } }),
        );
        if ("rejected" in optAnswer) throw new Error(`go/types rejected the optimized code: ${optAnswer.rejected}`);
        if (!("layout" in optAnswer)) throw new Error("go/types gave no layout");
        const { code: recordedFor, ...layout } = optAnswer.layout as ForCode;
        if (recordedFor !== digest(source)) {
          throw new Error(`The reordered code for ${target.id} changed since go/types' answer for it was recorded. Record it again with SP_RECORD_REFERENCES=1 and Go installed.`);
        }
        expect({ arch: target.id, ...shape(analysis.optimized!) }).toEqual({ arch: target.id, ...layout });

        // fieldalignment reports exactly what the real analyzer reports, with the same order.
        const fa = fieldalignment?.get(label)?.[target.id];
        const faAnswer = refs.answer(`${label} | fieldalignment on ${target.id}`, fa && { layout: fa });
        if (!("layout" in faAnswer)) throw new Error("fieldalignment gave no answer");
        const reported = faAnswer.layout as FieldAlignmentAnswer;
        expect({ arch: target.id, message: analysis.fieldalignment }).toEqual({ arch: target.id, message: reported.message });
        if (reported.order) {
          expect({ arch: target.id, order: analysis.optimizedFields.map((f) => f.name) }).toEqual({ arch: target.id, order: reported.order });
        }
      }
    });
  });

  rejected.forEach(([label, code], index) => {
    // Declared where the test is defined, so a filtered recording keeps the answers it does not run.
    refs.declare(`rejected: ${label}`);
    it(`rejects: ${label}`, () => {
      const now = compile ? rejectedTruths[index]! : undefined;
      const answer = refs.answer(`rejected: ${label}`, now && ("error" in now ? { rejected: now.error } : { layout: now }));
      if (!("rejected" in answer)) throw new Error("go/types accepts the case");
      for (const target of GC_TARGETS) {
        expect(analyzeGo(code, target.id).errors, `${target.id}: go/types says ${answer.rejected}`).not.toEqual([]);
      }
    });
  });

  // go/types is the compiler's model; this checks the compiler itself, through the verification
  // code the tool generates. Every case becomes a package of one module (one `go build` per
  // arch); amd64 and 386 binaries both run on an x86-64 host.
  describe.skipIf(process.arch !== "x64" || !compile)("the generated verification code agrees when compiled", () => {
    for (const goarch of ["amd64", "386"]) {
      it(`GOARCH=${goarch}`, async () => {
        const mod = join(dir, `verify-${goarch}`);
        mkdirSync(mod);
        writeFileSync(join(mod, "go.mod"), "module spverify\n\ngo 1.25\n");
        const main = ['package main', '', 'import (', '\t"fmt"'];
        const calls: string[] = [];
        // Code go/types rejects on this architecture has no program.
        const built = entries.map((e, index) => ({ e, index })).filter(({ e: [, code] }) => accepted(code, goarch));
        for (const { e: [, code], index } of built) {
          const analysis = analyzeGo(code, goarch);
          mkdirSync(join(mod, `case${index}`));
          writeFileSync(
            join(mod, `case${index}`, "case.go"),
            generateGoVerificationCode(code, analysis.definition!.name, analysis.fields, `case${index}`),
          );
          main.push(`\t"spverify/case${index}"`);
          calls.push(`\tfmt.Println("=== ${index}")`, `\tcase${index}.Report()`);
        }
        writeFileSync(join(mod, "main.go"), [...main, ')', '', 'func main() {', ...calls, '}', ''].join("\n"));

        const bin = join(mod, `verify${exe}`);
        await run("go", ["build", "-o", bin, "."], { cwd: mod, env: { ...process.env, GO111MODULE: "on", GOARCH: goarch } });
        const { stdout } = await run(bin, []);
        const sections = stdout.split(/^=== \d+\r?$/m).slice(1);
        expect(sections).toHaveLength(built.length);

        built.forEach(({ e: [label, code] }, i) => {
          const named = shape(analyzeGo(code, goarch).result!);
          expect({ label, ...parseProgramOutput(sections[i]!) }).toEqual({
            label,
            ...named,
            fields: named.fields.filter((f) => f.name !== "_"),
          });
        });
      }, 600_000);
    }

    it("the standalone program builds", async () => {
      const [, code] = entries[0]!;
      const analysis = analyzeGo(code, "amd64");
      const src = join(dir, "standalone.go");
      writeFileSync(src, generateGoVerificationCode(code, analysis.definition!.name, analysis.fields));
      const bin = join(dir, `standalone${exe}`);
      await run("go", ["build", "-o", bin, src], { env: { ...process.env, GO111MODULE: "off" } });
      const { stdout } = await run(bin, []);
      expect(parseProgramOutput(stdout)).toEqual(shape(analysis.result!));
    }, 600_000);
  });
});
