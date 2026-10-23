import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CCodeGenerator, analyzeStruct, examples } from "@sp/core";
import type { PlatformSelection } from "@sp/core";

/**
 * Ground truth: compile each case with the local GCC, run the generated verification program
 * and compare sizeof, alignof and every offsetof with the calculator.
 *
 * Runs on x86-64 Linux (System V; GitHub's Ubuntu runners have GCC) and x86-64 Windows with
 * MinGW-w64 (Windows x64 ABI), and skips anywhere else or when GCC is missing.
 */
// Async: back-to-back execFileSync calls block the worker for minutes, and vitest's RPC to it
// then fails with "Timeout calling onTaskUpdate".
const run = promisify(execFile);

const isX64 = process.arch === "x64";
const host: PlatformSelection | undefined =
  isX64 && process.platform === "linux"
    ? { target: "intel-x64-amd", dataModel: "LP64", os: "linux" }
    : isX64 && process.platform === "win32"
      ? { target: "intel-x64-amd", dataModel: "LLP64", os: "windows" }
      : undefined;

function hasGcc(): boolean {
  try {
    execFileSync("gcc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Bit-field examples are included on both hosts: the Windows model uses MSVC's rules, which
// MinGW follows by default (-mms-bitfields).
const CASES: Record<string, string> = {
  ...Object.fromEntries(examples.map((e) => [e.name, e.code.c])),
  "multi-word ints": "struct S { unsigned long long a; long long b; double c; unsigned short d; signed char e; short int f; };",
  "array of pointers / pointer to array": "struct S { char *names[4]; char (*row)[16]; const char *p; };",
  "function pointers, several declarators": "struct S { int a, b, *c; void (*cb)(int, char *); char d; };",
  "macro and expression sizes": "#define N 4\n#define M (N * 2 + 1)\nstruct S { char buf[M]; int x; char t[1 << 4]; };",
  "flexible array member": "struct S { int n; double d[]; };",
  "packed attribute": "struct __attribute__((packed)) S { char a; int b; double c; };",
  "#pragma pack push/pop": "#pragma pack(push, 2)\nstruct P { char a; int b; };\n#pragma pack(pop)\nstruct Q { char a; int b; struct P p; };",
  "#pragma pack(4)": "#pragma pack(4)\nstruct S { char c; double d; short s; };",
  "aligned struct": "struct S { char a; } __attribute__((aligned(16)));",
  "aligned member": "struct S { char a; int b __attribute__((aligned(16))); };",
  "_Alignas member": "struct S { char a; _Alignas(8) char b; };",
  "packed enum": "enum __attribute__((packed)) E { A, B };\nstruct S { enum E e; char c; };",
  "typedefs": "typedef unsigned int u32x;\ntypedef char *str_t;\ntypedef int vec3[3];\ntypedef void (*cb_t)(int);\nstruct S { u32x a; char b; str_t s; vec3 v; cb_t cb; };",
  "anonymous typedef struct": "typedef struct { char c; double d; } Pair;",
  "C11 anonymous union": "struct S { char tag; union { int i; double d; }; char t; };",
  "conditional compilation": "#define WIDE 1\n#if WIDE\ntypedef long long word;\n#else\ntypedef int word;\n#endif\nstruct S { char c; word w; };",
};

describe.skipIf(!host || !hasGcc())(`layouts match GCC on this ${process.platform} host`, () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-gcc-"));

  Object.entries(CASES).forEach(([label, code], index) => {
    it(label, async () => {
      const analysis = analyzeStruct(code, host!);
      expect(analysis.errors.map((e) => e.message)).toEqual([]);
      const result = analysis.result!;

      // A separate executable per case: Windows can keep the previous one locked while scanning it.
      const src = join(dir, `case${index}.c`);
      const exe = join(dir, `case${index}${process.platform === "win32" ? ".exe" : ""}`);
      writeFileSync(src, CCodeGenerator.generateVerificationCode(code, analysis.platform, result.struct.name, "c"));
      await run("gcc", ["-std=gnu11", "-o", exe, src]);
      const { stdout: out } = await run(exe, []);

      const offsets = Object.fromEntries(
        [...out.matchAll(/^\s+(\S+)\s+offset:\s+(\d+)/gm)].map((m) => [m[1], Number(m[2])]),
      );
      expect({
        size: Number(/Size of .*?: (\d+) bytes/.exec(out)?.[1]),
        align: Number(/Alignment: (\d+) bytes/.exec(out)?.[1]),
        offsets,
      }).toEqual({
        size: result.totalSize,
        align: result.struct.alignment,
        offsets: Object.fromEntries(
          result.members
            .filter((m) => m.member.name && m.member.bitField === undefined)
            .map((m) => [m.member.name, m.offset]),
        ),
      });
    });
  });
});
