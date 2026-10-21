import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { GO_TARGETS, analyzeGo, generateGoOptimizedCode, generateGoVerificationCode, goExamples } from "@sp/core";
import type { CalculationResult } from "@sp/core";

/**
 * Ground truth for Go: tests/fixtures/golayout type-checks each case with go/types and
 * types.SizesFor("gc", arch), which implements the gc compiler's layout rules, for every
 * architecture. The calculator must agree on size, alignment and every field offset.
 *
 * The helper is built and run once for all cases (asynchronously: it takes a while, and a
 * blocked worker times out vitest's RPC).
 *
 * Skips when Go is not installed.
 */
function hasGo(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CASES: Record<string, string> = {
  ...Object.fromEntries(goExamples.map((e) => [e.name, e.code])),
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
};

interface HelperLayout {
  size: number;
  align: number;
  fields: Array<{ name: string; offset: number; size: number }>;
}

type HelperOutput = { name: string; archs: Record<string, HelperLayout> } | { error: string };

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

describe.skipIf(!hasGo())("Go layouts match go/types (gc) for every architecture", () => {
  const entries = Object.entries(CASES);
  /** go/types' answer for each case as written. */
  let truths: HelperOutput[] = [];
  /** go/types' answer for each distinct reordered source (the order can differ per arch). */
  const optimizedTruths = new Map<string, HelperOutput>();
  let dir = "";

  const optimizedSource = (code: string, targetId: string) => {
    const a = analyzeGo(code, targetId);
    return generateGoOptimizedCode(code, a.definition!.name, a.optimizedFields);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sp-go-"));
    const helper = join(dir, `golayout${exe}`);
    await run("go", ["build", "-o", helper, "main.go"], {
      cwd: resolve(__dirname, "fixtures/golayout"),
      env: { ...process.env, GO111MODULE: "off" },
    });

    const sources = entries.map(([, code]) => code);
    const optimized = [...new Set(entries.flatMap(([, code]) => GC_TARGETS.map((t) => optimizedSource(code, t.id))))];
    const files = [...sources, ...optimized].map((code, index) => {
      const src = join(dir, `case${index}.go`);
      writeFileSync(src, code);
      return src;
    });
    const { stdout } = await run(helper, files, { maxBuffer: 256 * 1024 * 1024 });
    const all = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as HelperOutput);
    truths = all.slice(0, sources.length);
    optimized.forEach((code, i) => optimizedTruths.set(code, all[sources.length + i]!));
  }, 600_000);

  entries.forEach(([label, code], index) => {
    it(label, () => {
      const truth = truths[index]!;
      if ("error" in truth) throw new Error(`go/types rejected the case: ${truth.error}`);

      for (const target of GC_TARGETS) {
        const analysis = analyzeGo(code, target.id);
        expect(analysis.errors.map((e) => e.message), target.id).toEqual([]);
        const result = analysis.result!;
        expect(result.struct.name).toBe(truth.name);
        expect({ arch: target.id, ...shape(result) }).toEqual({ arch: target.id, ...truth.archs[target.id] });

        // The reordered struct, as generated, compiles to the layout the calculator predicts,
        // and is never larger.
        const opt = optimizedTruths.get(optimizedSource(code, target.id))!;
        if ("error" in opt) throw new Error(`go/types rejected the optimized code: ${opt.error}`);
        expect({ arch: target.id, ...shape(analysis.optimized!) }).toEqual({ arch: target.id, ...opt.archs[target.id] });
        expect(analysis.optimized!.totalSize).toBeLessThanOrEqual(result.totalSize);
      }
    });
  });

  // go/types is the compiler's model; this checks the compiler itself, through the verification
  // code the tool generates. Every case becomes a package of one module (one `go build` per
  // arch); amd64 and 386 binaries both run on an x86-64 host.
  describe.skipIf(process.arch !== "x64")("the generated verification code agrees when compiled", () => {
    for (const goarch of ["amd64", "386"]) {
      it(`GOARCH=${goarch}`, async () => {
        const mod = join(dir, `verify-${goarch}`);
        mkdirSync(mod);
        writeFileSync(join(mod, "go.mod"), "module spverify\n\ngo 1.21\n");
        const main = ['package main', '', 'import (', '\t"fmt"'];
        const calls: string[] = [];
        entries.forEach(([, code], index) => {
          const analysis = analyzeGo(code, goarch);
          mkdirSync(join(mod, `case${index}`));
          writeFileSync(
            join(mod, `case${index}`, "case.go"),
            generateGoVerificationCode(code, analysis.definition!.name, analysis.fields, `case${index}`),
          );
          main.push(`\t"spverify/case${index}"`);
          calls.push(`\tfmt.Println("=== ${index}")`, `\tcase${index}.Report()`);
        });
        writeFileSync(join(mod, "main.go"), [...main, ')', '', 'func main() {', ...calls, '}', ''].join("\n"));

        const bin = join(mod, `verify${exe}`);
        await run("go", ["build", "-o", bin, "."], { cwd: mod, env: { ...process.env, GO111MODULE: "on", GOARCH: goarch } });
        const { stdout } = await run(bin, []);
        const sections = stdout.split(/^=== \d+\r?$/m).slice(1);
        expect(sections).toHaveLength(entries.length);

        entries.forEach(([label], index) => {
          const named = shape(analyzeGo(entries[index]![1], goarch).result!);
          expect({ label, ...parseProgramOutput(sections[index]!) }).toEqual({
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
