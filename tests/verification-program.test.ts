import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { examples } from "@sp/core";
import type { CalculationResult, SourceLanguage } from "@sp/core";
import { layoutToolDefinition } from "@sp/layout/definition";
import type { LayoutData } from "@sp/layout/compute";
import { hasTool, msvc, tool, vcvarsall } from "./support/compilers";
import { References, digest, useReferences } from "./support/references";
import type { Answer } from "./support/references";

/**
 * The Verification Code tool's program, for every example in every mode and for more cases, built
 * with the target's own compiler and run: what it prints must be what the Struct Layout tool shows
 * for the same options. This is the program a user downloads, so it is checked as they would use it.
 *
 * x86-64 Linux programs are built with gcc and g++ (through WSL on Windows); Windows programs with
 * MSVC for x64 and x86. What each program printed is recorded (tests/references/verification.json)
 * with a digest of the program, so that without the compiler, or with SP_USE_REFERENCES=1, the
 * layout is checked against what the compiled program printed, as long as the program is the same.
 */
const run = promisify(execFile);
const requireCompilers = Boolean(process.env.SP_REQUIRE_COMPILERS);
const requireMsvc = Boolean(process.env.SP_REQUIRE_MSVC);

const layout = layoutToolDefinition("struct-layout");
const verify = layoutToolDefinition("verification-code");

interface Target {
  name: string;
  options: { target: string; dataModel: string; os: string };
  compiler: "gcc" | "msvc";
  msvc?: "x64" | "x86";
}
const TARGETS: Target[] = [
  { name: "x86-64 Linux (gcc, g++)", options: { target: "intel-x64-amd", dataModel: "LP64", os: "linux" }, compiler: "gcc" },
  { name: "x86-64 Windows (MSVC)", options: { target: "intel-x64-amd", dataModel: "LLP64", os: "windows" }, compiler: "msvc", msvc: "x64" },
  { name: "i386 Windows (MSVC)", options: { target: "intel-x86", dataModel: "ILP32", os: "windows" }, compiler: "msvc", msvc: "x86" },
];

interface Case {
  label: string;
  code: string;
  language: SourceLanguage;
  mode: "natural" | "packed" | "optimized";
  /** GCC syntax MSVC rejects. */
  gnu?: boolean;
}

/** More of what the parser takes, as declared. */
const MORE: Array<Omit<Case, "mode">> = [
  { label: "multi-word ints", code: "struct S { unsigned long long a; long long b; double c; unsigned short d; signed char e; short int f; };", language: "c" },
  { label: "array of pointers / pointer to array", code: "struct S { char *names[4]; char (*row)[16]; const char *p; };", language: "c" },
  { label: "function pointers, several declarators", code: "struct S { int a, b, *c; void (*cb)(int, char *); char d; };", language: "c" },
  { label: "macro and expression sizes", code: "#define N 4\n#define M (N * 2 + 1)\nstruct S { char buf[M]; int x; char t[1 << 4]; };", language: "c" },
  { label: "function-like macro and sizeof", code: "#define PAD(n) char pad_##n[n]\nstruct H { char c; double d; };\nstruct S { PAD(3); char tail[32 - sizeof(struct H)]; int x; };", language: "c" },
  { label: "flexible array member", code: "struct S { int n; double d[]; };", language: "c" },
  { label: "packed attribute", code: "struct __attribute__((packed)) S { char a; int b; double c; };", language: "c", gnu: true },
  { label: "#pragma pack push/pop", code: "#pragma pack(push, 2)\nstruct P { char a; int b; };\n#pragma pack(pop)\nstruct Q { char a; int b; struct P p; };", language: "c" },
  { label: "#pragma pack(4)", code: "#pragma pack(4)\nstruct S { char c; double d; short s; };", language: "c" },
  { label: "aligned struct", code: "struct S { char a; } __attribute__((aligned(16)));", language: "c", gnu: true },
  { label: "aligned member", code: "struct S { char a; int b __attribute__((aligned(16))); };", language: "c", gnu: true },
  { label: "_Alignas member", code: "struct S { char a; _Alignas(8) char b; };", language: "c" },
  { label: "packed enum", code: "enum __attribute__((packed)) E { A, B };\nstruct S { enum E e; char c; };", language: "c", gnu: true },
  { label: "typedefs", code: "typedef unsigned int u32x;\ntypedef char *str_t;\ntypedef int vec3[3];\ntypedef void (*cb_t)(int);\nstruct S { u32x a; char b; str_t s; vec3 v; cb_t cb; };", language: "c" },
  { label: "anonymous typedef struct", code: "typedef struct { char c; double d; } Pair;", language: "c" },
  { label: "C11 anonymous union", code: "struct S { char tag; union { int i; double d; }; char t; };", language: "c" },
  { label: "conditional compilation", code: "#define WIDE 1\n#if WIDE\ntypedef long long word;\n#else\ntypedef int word;\n#endif\nstruct S { char c; word w; };", language: "c" },
  // C++: the program also prints the base class offsets.
  { label: "C++: two bases", code: "struct A { int a; char c; A(); }; struct B { short b; }; struct S : A, B { char s; };", language: "c++17" },
  { label: "C++: virtual functions", code: "struct A { virtual ~A(); int a; }; struct S : A { void f(); double d; };", language: "c++17" },
  { label: "C++: empty base", code: "struct E {}; struct S : E { int x; E e; };", language: "c++20" },
  { label: "C++: private members", code: "class S { int a; char c; public: int b; S(); };", language: "c++17" },
  { label: "C++: virtual base", code: "struct V { int v; }; struct S : virtual V { int s; };", language: "c++17" },
];

const CASES: Case[] = [
  ...examples.flatMap((e) =>
    (e.language === "c" ? (["c", "c++17"] as const) : (["c++17", "c++20"] as const)).flatMap((language) =>
      (["natural", "packed", "optimized"] as const).map((mode) => ({ label: `${e.name} [${language}, ${mode}]`, code: e.code, language, mode })),
    ),
  ),
  ...MORE.map((c) => ({ ...c, label: `${c.label} [${c.language}]`, mode: "natural" as const })),
];

/** What the program printed: size, alignment, and the offset of each member and base it names. */
interface Printed {
  size: number;
  align: number | undefined;
  offsets: Record<string, number>;
}
/** A recording: what the program with this digest printed. */
interface Ran {
  code: string;
  printed: Printed;
}

function parseOutput(out: string): Printed {
  return {
    size: Number(/Size of .*?: (\d+) bytes/.exec(out)?.[1]),
    align: Number(/Alignment: (\d+) bytes/.exec(out)?.[1]),
    offsets: Object.fromEntries([...out.matchAll(/^\s+(.+?)\s+offset:\s+(\d+)/gm)].map((m) => [m[1]!, Number(m[2])])),
  };
}

/** The same, from the layout the Struct Layout tool shows: what the program can print about it. */
function expectedOutput(shown: CalculationResult): Printed {
  const bases = shown.struct.cpp?.bases ?? [];
  const once = (name: string) => shown.members.filter((m) => m.member.role === "base" && m.member.name === name).length === 1;
  return {
    size: shown.totalSize,
    align: shown.struct.alignment,
    offsets: Object.fromEntries(
      shown.members
        .filter((m) =>
          m.member.role === "base"
            ? bases.find((b) => b.def.name === m.member.name)?.access === "public" && once(m.member.name)
            : !m.member.role && !!m.member.name && m.member.bitField === undefined && !m.member.access,
        )
        .map((m) => [m.member.role === "base" ? `base ${m.member.name}` : m.member.name, m.offset]),
    ),
  };
}

const refs = new References<Ran>("verification");
afterAll(() => refs.save());

for (const target of TARGETS) {
  const installed = target.compiler === "msvc" ? vcvarsall !== null : hasTool("gcc") && hasTool("g++");
  if (!installed && (target.compiler === "msvc" ? requireMsvc : requireCompilers)) {
    it(`a compiler is installed for ${target.name}`, () => {
      throw new Error(`no compiler for ${target.name}`);
    });
    continue;
  }
  const compile = installed && !useReferences;
  const cases = CASES.map((c, i) => {
    const options = { ...target.options, language: c.language, mode: c.mode };
    return { ...c, i, options, program: verify.compute(verify.createSpec(options), c.code) };
  }).filter((c) => !(c.gnu && target.compiler === "msvc"));

  describe(`verification programs on ${target.name}${compile ? "" : " (recorded output)"}`, () => {
    const answers = new Map<number, Answer<Ran>>();

    beforeAll(async () => {
      if (!compile) return;
      const dir = mkdtempSync(join(tmpdir(), "sp-verify-"));
      const file = (i: number) => `p${i}.${CASES[i]!.language === "c" ? "c" : "cpp"}`;
      const built = cases.filter((c) => !c.program.error && c.program.files?.[0]);
      for (const c of built) writeFileSync(join(dir, file(c.i)), c.program.files![0]!.content);
      if (target.compiler === "gcc") {
        const steps = built.map(({ i, language }) => {
          const cc = language === "c" ? "gcc -std=gnu11" : `g++ -std=${language}`;
          return `${cc} -w -o p${i}.out ${file(i)} > p${i}.log 2>&1 && ./p${i}.out > p${i}.txt 2>> p${i}.log`;
        });
        await tool("sh", ["-c", steps.join("; ")], dir);
      } else {
        // A few cl runs at a time: each links its own program.
        const queue = [...built];
        await Promise.all(
          Array.from({ length: 6 }, async () => {
            for (let c = queue.shift(); c !== undefined; c = queue.shift()) {
              const std = c.language === "c" ? "/std:c11" : `/std:${c.language}`;
              const { code, output } = await msvc(target.msvc!, ["/w", std, "/EHsc", `/Fep${c.i}.exe`, file(c.i)], dir);
              if (code !== 0) {
                writeFileSync(join(dir, `p${c.i}.log`), output);
                continue;
              }
              writeFileSync(join(dir, `p${c.i}.txt`), (await run(join(dir, `p${c.i}.exe`), [], { cwd: dir })).stdout);
            }
          }),
        );
      }
      for (const c of built) {
        const out = join(dir, `p${c.i}.txt`);
        const log = join(dir, `p${c.i}.log`);
        answers.set(
          c.i,
          existsSync(out)
            ? { layout: { code: digest(c.program.files![0]!.content), printed: parseOutput(readFileSync(out, "utf8")) } }
            : { rejected: existsSync(log) ? readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).slice(0, 8).join("\n") : "no output" },
        );
      }
    }, 900_000);

    for (const c of cases) {
      const key = `${target.name} | ${c.label}`;
      refs.declare(key);
      it(c.label, () => {
        expect(c.program.error).toBeUndefined();
        const program = c.program.files![0]!.content;
        const truth = refs.answer(key, compile ? answers.get(c.i) : undefined);
        if ("rejected" in truth) throw new Error(`the program does not build and run: ${truth.rejected}`);
        if (!("layout" in truth)) throw new Error("the program printed nothing");
        if (truth.layout.code !== digest(program)) {
          throw new Error(`The program changed since what it printed was recorded. Record it again with SP_RECORD_REFERENCES=1 and ${target.compiler === "msvc" ? "MSVC" : "gcc"} installed.`);
        }
        const shown = (layout.compute(layout.createSpec(c.options), c.code).data as LayoutData).display!;
        expect(truth.layout.printed).toEqual(expectedOutput(shown));
      });
    }
  });
}
