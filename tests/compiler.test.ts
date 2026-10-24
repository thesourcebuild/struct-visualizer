import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { CCodeGenerator, analyzeStruct, examples } from "@sp/core";
import type { PlatformSelection, SourceLanguage } from "@sp/core";
import { msvc, msvcEnvironment, vcvarsall } from "./support/compilers";

/**
 * End to end: the Verification Code tool's program for each case is compiled with the host's
 * compiler, as the tool tells the user to, and run; the sizeof, alignof, offsetof and base class
 * offsets it prints must be the calculator's.
 *
 * x86-64 Linux uses GCC (System V; GitHub's Ubuntu runners have it), x86-64 Windows uses MSVC,
 * which the Windows targets model. Anywhere else, or when the compiler is missing, it skips.
 */
// Async: back-to-back execFileSync calls block the worker for minutes, and vitest's RPC to it
// then fails with "Timeout calling onTaskUpdate".
const run = promisify(execFile);

const isX64 = process.arch === "x64";
const host: { selection: PlatformSelection; compiler: "gcc" | "msvc" } | undefined =
  isX64 && process.platform === "linux"
    ? { selection: { target: "intel-x64-amd", dataModel: "LP64", os: "linux" }, compiler: "gcc" }
    : isX64 && process.platform === "win32" && vcvarsall
      ? { selection: { target: "intel-x64-amd", dataModel: "LLP64", os: "windows" }, compiler: "msvc" }
      : undefined;

function hasGcc(): boolean {
  try {
    execFileSync("gcc", ["--version"], { stdio: "ignore" });
    execFileSync("g++", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const available = host !== undefined && (host.compiler === "msvc" || hasGcc());

interface Case {
  code: string;
  language: SourceLanguage;
  /** GCC syntax MSVC rejects. */
  gnu?: boolean;
}

const CASES: Record<string, Case> = {
  ...Object.fromEntries(examples.map((e) => [e.name, { code: e.code, language: e.language }])),
  "multi-word ints": { code: "struct S { unsigned long long a; long long b; double c; unsigned short d; signed char e; short int f; };", language: "c" },
  "array of pointers / pointer to array": { code: "struct S { char *names[4]; char (*row)[16]; const char *p; };", language: "c" },
  "function pointers, several declarators": { code: "struct S { int a, b, *c; void (*cb)(int, char *); char d; };", language: "c" },
  "macro and expression sizes": { code: "#define N 4\n#define M (N * 2 + 1)\nstruct S { char buf[M]; int x; char t[1 << 4]; };", language: "c" },
  "function-like macro and sizeof": { code: "#define PAD(n) char pad_##n[n]\nstruct H { char c; double d; };\nstruct S { PAD(3); char tail[32 - sizeof(struct H)]; int x; };", language: "c" },
  "flexible array member": { code: "struct S { int n; double d[]; };", language: "c" },
  "packed attribute": { code: "struct __attribute__((packed)) S { char a; int b; double c; };", language: "c", gnu: true },
  "#pragma pack push/pop": { code: "#pragma pack(push, 2)\nstruct P { char a; int b; };\n#pragma pack(pop)\nstruct Q { char a; int b; struct P p; };", language: "c" },
  "#pragma pack(4)": { code: "#pragma pack(4)\nstruct S { char c; double d; short s; };", language: "c" },
  "aligned struct": { code: "struct S { char a; } __attribute__((aligned(16)));", language: "c", gnu: true },
  "aligned member": { code: "struct S { char a; int b __attribute__((aligned(16))); };", language: "c", gnu: true },
  "_Alignas member": { code: "struct S { char a; _Alignas(8) char b; };", language: "c" },
  "packed enum": { code: "enum __attribute__((packed)) E { A, B };\nstruct S { enum E e; char c; };", language: "c", gnu: true },
  "typedefs": { code: "typedef unsigned int u32x;\ntypedef char *str_t;\ntypedef int vec3[3];\ntypedef void (*cb_t)(int);\nstruct S { u32x a; char b; str_t s; vec3 v; cb_t cb; };", language: "c" },
  "anonymous typedef struct": { code: "typedef struct { char c; double d; } Pair;", language: "c" },
  "C11 anonymous union": { code: "struct S { char tag; union { int i; double d; }; char t; };", language: "c" },
  "conditional compilation": { code: "#define WIDE 1\n#if WIDE\ntypedef long long word;\n#else\ntypedef int word;\n#endif\nstruct S { char c; word w; };", language: "c" },
  // C++: the program also prints the base class offsets.
  "C++: two bases": { code: "struct A { int a; char c; A(); }; struct B { short b; }; struct S : A, B { char s; };", language: "c++17" },
  "C++: virtual functions": { code: "struct A { virtual ~A(); int a; }; struct S : A { void f(); double d; };", language: "c++17" },
  "C++: empty base": { code: "struct E {}; struct S : E { int x; E e; };", language: "c++20" },
  "C++: private members": { code: "class S { int a; char c; public: int b; S(); };", language: "c++17" },
  "C++: virtual base": { code: "struct V { int v; }; struct S : virtual V { int s; };", language: "c++17" },
};

async function compileAndRun(dir: string, index: number, source: string, language: SourceLanguage): Promise<string> {
  const ext = language === "c" ? "c" : "cpp";
  const src = join(dir, `case${index}.${ext}`);
  // A separate executable per case: Windows can keep the previous one locked while scanning it.
  const exe = join(dir, `case${index}${process.platform === "win32" ? ".exe" : ""}`);
  writeFileSync(src, source);
  if (host!.compiler === "msvc") {
    const std = language === "c" ? "/std:c11" : `/std:${language}`;
    const { code, output } = await msvc("x64", ["/w", std, "/EHsc", `/Fecase${index}.exe`, `case${index}.${ext}`], dir);
    if (code !== 0) throw new Error(output);
  } else {
    await run(language === "c" ? "gcc" : "g++", [language === "c" ? "-std=gnu11" : `-std=${language}`, "-w", "-o", exe, src]);
  }
  return (await run(exe, [])).stdout;
}

describe.skipIf(!available)(`layouts match ${host?.compiler === "msvc" ? "MSVC" : "GCC"} on this ${process.platform} host`, () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-host-"));

  // vcvarsall sets up MSVC once, before the cases, so no case's time limit pays for it.
  beforeAll(async () => {
    if (host!.compiler === "msvc") await msvcEnvironment("x64");
  }, 600_000);

  Object.entries(CASES).forEach(([label, c], index) => {
    it(label, async (ctx) => {
      if (c.gnu && host!.compiler === "msvc") {
        ctx.skip("GCC syntax, which MSVC rejects");
        return;
      }
      const analysis = analyzeStruct(c.code, host!.selection, { language: c.language });
      expect(analysis.errors.map((e) => e.message)).toEqual([]);
      const result = analysis.result!;
      const target = { architecture: analysis.platform.architecture, dataModel: analysis.platform.dataModel, language: c.language };
      const program = CCodeGenerator.generateVerificationCode(c.code, target, result.struct.name, c.language === "c" ? "c" : "cpp");
      const out = await compileAndRun(dir, index, program, c.language);

      const printed = Object.fromEntries([...out.matchAll(/^\s+(.+?)\s+offset:\s+(\d+)/gm)].map((m) => [m[1], Number(m[2])]));
      const accessible = (r: (typeof result.members)[number]) =>
        r.member.role === "base"
          ? result.struct.cpp?.bases.find((b) => b.def.name === r.member.name)?.access === "public"
          : !r.member.role && !!r.member.name && r.member.bitField === undefined && !r.member.access;
      expect({
        size: Number(/Size of .*?: (\d+) bytes/.exec(out)?.[1]),
        align: Number(/Alignment: (\d+) bytes/.exec(out)?.[1]),
        offsets: printed,
      }).toEqual({
        size: result.totalSize,
        align: result.struct.alignment,
        offsets: Object.fromEntries(
          result.members.filter(accessible).map((m) => [m.member.role === "base" ? `base ${m.member.name}` : m.member.name, m.offset]),
        ),
      });
    });
  });
});
