import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { examples } from "@sp/core";
import type { CalculationResult, SourceLanguage } from "@sp/core";
import { layoutToolDefinition } from "@sp/layout/definition";
import type { LayoutData } from "@sp/layout/compute";
import { hasTool, msvc, tool, vcvarsall } from "./support/compilers";

/**
 * The Verification Code tool's program, for every example in every mode, built with the target's
 * own compiler and run: what it prints must be what the Struct Layout tool shows for the same
 * options. This is the program a user downloads, so it is checked as they would use it.
 *
 * x86-64 Linux programs are built with gcc and g++ (through WSL on Windows); Windows programs with
 * MSVC for x64 and x86.
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
}
const CASES: Case[] = examples.flatMap((e) =>
  (e.language === "c" ? (["c", "c++17"] as const) : (["c++17", "c++20"] as const)).flatMap((language) =>
    (["natural", "packed", "optimized"] as const).map((mode) => ({ label: `${e.name} [${language}, ${mode}]`, code: e.code, language, mode })),
  ),
);

/** What the program prints: size, alignment, and the offset of each member and base it names. */
function parseOutput(out: string) {
  return {
    size: Number(/Size of .*?: (\d+) bytes/.exec(out)?.[1]),
    align: Number(/Alignment: (\d+) bytes/.exec(out)?.[1]),
    offsets: Object.fromEntries([...out.matchAll(/^\s+(.+?)\s+offset:\s+(\d+)/gm)].map((m) => [m[1]!, Number(m[2])])),
  };
}

/** The same, from the layout the Struct Layout tool shows: what the program can print about it. */
function expectedOutput(shown: CalculationResult) {
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

for (const target of TARGETS) {
  const installed = target.compiler === "msvc" ? vcvarsall !== null : hasTool("gcc") && hasTool("g++");
  if (!installed) {
    if (target.compiler === "msvc" ? requireMsvc : requireCompilers) {
      it(`a compiler is installed for ${target.name}`, () => {
        throw new Error(`no compiler for ${target.name}`);
      });
    }
    continue;
  }
  describe(`verification programs on ${target.name}`, () => {
    const outputs = new Map<number, string>();

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), "sp-verify-"));
      CASES.forEach((c, i) => {
        const spec = verify.createSpec({ ...target.options, language: c.language, mode: c.mode });
        const result = verify.compute(spec, c.code);
        if (result.error || !result.files?.[0]) return;
        writeFileSync(join(dir, `p${i}.${c.language === "c" ? "c" : "cpp"}`), result.files[0].content);
      });
      const built = CASES.map((_, i) => i).filter((i) => existsSync(join(dir, `p${i}.c`)) || existsSync(join(dir, `p${i}.cpp`)));
      const file = (i: number) => `p${i}.${CASES[i]!.language === "c" ? "c" : "cpp"}`;
      if (target.compiler === "gcc") {
        const steps = built.map((i) => {
          const c = CASES[i]!;
          const cc = c.language === "c" ? "gcc -std=gnu11" : `g++ -std=${c.language}`;
          return `${cc} -w -o p${i}.out ${file(i)} > p${i}.log 2>&1 && ./p${i}.out > p${i}.txt 2>> p${i}.log`;
        });
        await tool("sh", ["-c", steps.join("; ")], dir);
      } else {
        // A few cl runs at a time: each links its own program.
        const queue = [...built];
        await Promise.all(
          Array.from({ length: 6 }, async () => {
            for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
              const c = CASES[i]!;
              const std = c.language === "c" ? "/std:c11" : `/std:${c.language}`;
              const { code, output } = await msvc(target.msvc!, ["/w", std, "/EHsc", `/Fep${i}.exe`, file(i)], dir);
              if (code !== 0) {
                writeFileSync(join(dir, `p${i}.log`), output);
                continue;
              }
              writeFileSync(join(dir, `p${i}.txt`), (await run(join(dir, `p${i}.exe`), [], { cwd: dir })).stdout);
            }
          }),
        );
      }
      for (const i of built) {
        const out = join(dir, `p${i}.txt`);
        outputs.set(i, existsSync(out) ? readFileSync(out, "utf8") : `BUILD FAILED\n${existsSync(join(dir, `p${i}.log`)) ? readFileSync(join(dir, `p${i}.log`), "utf8") : ""}`);
      }
    }, 900_000);

    CASES.forEach((c, i) => {
      it(c.label, () => {
        const options = { ...target.options, language: c.language, mode: c.mode };
        const verified = verify.compute(verify.createSpec(options), c.code);
        expect(verified.error).toBeUndefined();
        const shown = (layout.compute(layout.createSpec(options), c.code).data as LayoutData).display!;
        const out = outputs.get(i) ?? "";
        expect(out, "the program builds and runs").not.toMatch(/^BUILD FAILED/);
        expect(parseOutput(out)).toEqual(expectedOutput(shown));
      });
    });
  });
}
