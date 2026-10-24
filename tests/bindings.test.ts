import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { PaddingCalculator, analyzeStruct, bindingTargetName, examples, generateBindings } from "@sp/core";
import type { BindingLanguage, BindingOutput, CalculationResult, PlatformSelection } from "@sp/core";

/**
 * Every binding the Bindings tool writes is compiled by its language and its layout read back
 * there: the size of the struct and the offset of each of its members must be the C layout's on
 * that target. Zig and Rust check at compile time for the target itself; Go for each GOARCH;
 * Python's struct and ctypes and C#'s explicit layout do not depend on the machine, so they run
 * here.
 *
 * Rust: with the stable compiler for the targets rustup ships a standard library for (rustup
 * target add), and by building core from source on nightly (-Zbuild-std) for the tier-3 targets it
 * ships none for (MIPS, AVR). SP_REQUIRE_BINDING_TOOLCHAINS makes a target left unchecked a failure.
 */
const run = promisify(execFile);
const requireToolchains = Boolean(process.env.SP_REQUIRE_BINDING_TOOLCHAINS);
/** Windows names it python; Linux distributions python3. */
const PYTHON = process.platform === "win32" ? "python" : "python3";

function has(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}
const toolchains = {
  zig: has("zig", ["version"]),
  rust: has("rustc", ["--version"]),
  go: has("go", ["version"]),
  python: has(PYTHON, ["--version"]),
  dotnet: has("dotnet", ["--version"]),
};
const rustupLines = (args: string[]) => {
  try {
    return execFileSync("rustup", args, { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
};
/** Targets whose standard library is installed for the stable compiler. */
const rustTargets = new Set(toolchains.rust ? rustupLines(["target", "list", "--installed"]) : []);
/** Targets rustup distributes a standard library for; the rest are tier 3. */
const rustupTargets = new Set(toolchains.rust ? rustupLines(["target", "list"]).map((l) => l.replace(/ \(.*\)$/, "")) : []);
/** A nightly toolchain with the library source, to build core for a tier-3 target. */
const buildStd = toolchains.rust && rustupLines(["component", "list", "--toolchain", "nightly", "--installed"]).some((l) => l.startsWith("rust-src"));
/**
 * Where cargo keeps the core it builds for the tier-3 targets: building it is most of the time
 * they take, and it is reused by later runs with the same nightly (CI caches the directory).
 */
const buildStdDir = process.env.SP_RUST_BUILD_STD_DIR || join(tmpdir(), "sp-rust-build-std");
/** Targets that need a CPU named (AVR has no default). */
const RUST_FLAGS: Record<string, string[]> = { "avr-none": ["-C", "target-cpu=atmega328p"] };

const TARGETS: Array<{ name: string; selection: PlatformSelection }> = [
  { name: "x86-64 Linux", selection: { target: "intel-x64-amd", dataModel: "LP64", os: "linux" } },
  { name: "x86-64 Windows", selection: { target: "intel-x64-amd", dataModel: "LLP64", os: "windows" } },
  { name: "i386 Linux", selection: { target: "intel-x86", dataModel: "ILP32", os: "linux" } },
  { name: "i386 Windows", selection: { target: "intel-x86", dataModel: "ILP32", os: "windows" } },
  { name: "ARM32 Linux", selection: { target: "arm32", dataModel: "ILP32", os: "linux" } },
  { name: "ARM32 bare metal", selection: { target: "arm32", dataModel: "ILP32", os: "none" } },
  { name: "AArch64 Linux", selection: { target: "arm64", dataModel: "LP64", os: "linux" } },
  { name: "RISC-V 32 bare metal", selection: { target: "riscv32", dataModel: "ILP32", os: "none" } },
  { name: "RISC-V 64 Linux", selection: { target: "riscv64", dataModel: "LP64", os: "linux" } },
  { name: "PowerPC 32 Linux", selection: { target: "powerpc32", dataModel: "ILP32", os: "linux" } },
  { name: "MIPS32 big-endian Linux", selection: { target: "mips32-be", dataModel: "ILP32", os: "linux" } },
  { name: "PIC32 (XC32)", selection: { target: "microchip-32bit", dataModel: "XC32", os: "none" } },
  { name: "AVR (XC8)", selection: { target: "microchip-8bit", dataModel: "XC8", os: "none" } },
];

const CASES: Record<string, string> = {
  ...Object.fromEntries(examples.filter((e) => e.language === "c").map((e) => [e.name, e.code])),
  "bit-fields between members": "struct S { char a; unsigned b : 3; unsigned c : 9; short d; int e : 4; };",
  "packed struct": "struct __attribute__((packed)) S { char a; int b; double c; short d; };",
  "pragma pack 2": "#pragma pack(push, 2)\nstruct S { char a; long long b; char c; int d; };\n#pragma pack(pop)",
  "aligned member": "struct S { char a; int b __attribute__((aligned(16))); char c; };",
  "aligned struct": "struct S { char a; short b; } __attribute__((aligned(8)));",
  "aligned typedef": "typedef int a8 __attribute__((aligned(8)));\nstruct S { char a; a8 b; char c; };",
  "union": "union S { char c; int i; double d; short s[3]; };",
  "64-bit members": "struct S { char a; long long b; char c; double d; unsigned long long e; };",
  "pointers and function pointers": "struct S { char a; void *p; char b; int (*f)(int); char *names[3]; };",
  "bool and enum": "enum E { E_A = -1, E_B = 300 };\nstruct S { _Bool a; enum E e; _Bool b; };",
  "two-dimensional arrays": "struct S { char a; short m[3][4]; int g[2][2]; };",
  "flexible array member": "struct S { short n; int data[]; };",
  "long double": "struct S { char a; long double x; char b; };",
  "nested anonymous": "struct S { char tag; union { int i; float f; } v; struct { char x; long y; } p; };",
};

const LANGUAGES: BindingLanguage[] = ["zig", "rust", "go", "csharp", "python-struct", "python-ctypes"];
const GNU_ONLY = (code: string) => /__attribute__/.test(code);

interface Prepared {
  target: (typeof TARGETS)[number];
  index: number;
  label: string;
  result: CalculationResult;
  bindings: Map<BindingLanguage, BindingOutput>;
  /** What the binding must have: the struct's size and its own members' offsets. */
  expected: { size: number; offsets: Record<string, number>; union: boolean; flexible?: string };
}

const prepared: Prepared[] = [];
TARGETS.forEach((target) => {
  Object.entries(CASES).forEach(([label, code]) => {
    if (target.selection.os === "windows" && GNU_ONLY(code)) return; // MSVC does not take __attribute__
    const analysis = analyzeStruct(code, target.selection);
    if (analysis.errors.length > 0 || !analysis.result) throw new Error(`${label}: ${analysis.errors.map((e) => e.message).join("; ")}`);
    const result = analysis.result;
    const calculator = new PaddingCalculator(analysis.platform.architecture, analysis.platform.dataModel);
    const bindings = new Map(LANGUAGES.map((l) => [l, generateBindings(result, analysis.platform, calculator, l)] as const));
    const named = result.members.filter((m) => m.member.name && m.member.bitField === undefined && !m.member.role);
    const flexible = named.find((m) => m.member.arraySize === 0)?.member.name;
    prepared.push({
      target,
      index: prepared.length,
      label,
      result,
      bindings,
      expected: { size: result.totalSize, offsets: Object.fromEntries(named.map((m) => [m.member.name, m.offset])), union: result.struct.isUnion === true, ...(flexible && { flexible }) },
    });
  });
});

const rootName = (p: Prepared) => p.result.struct.name;
/** Members the binding keeps: Go, C# and Python leave a flexible array member out. */
const kept = (p: Prepared, language: BindingLanguage) =>
  Object.entries(p.expected.offsets).filter(([name]) => name !== p.expected.flexible || language === "zig" || language === "rust" || language === "python-ctypes");

/** Per language: the errors its compiler reported for each prepared case, keyed by index. */
const failures = new Map<BindingLanguage, Map<number, string>>();
const ran = new Map<BindingLanguage, Set<number>>();
/** Per language: why a case could not be compiled here, keyed by index. */
const unavailable = new Map<BindingLanguage, Map<number, string>>();

const dir = mkdtempSync(join(tmpdir(), "sp-bind-"));

async function checkZig() {
  const byTarget = new Map<string, Prepared[]>();
  for (const p of prepared) {
    const t = bindingTargetName("zig", analyzeStruct("struct S { int a; };", p.target.selection).platform);
    if (!t || p.bindings.get("zig")!.error) continue;
    byTarget.set(t, [...(byTarget.get(t) ?? []), p]);
  }
  for (const [target, cases] of byTarget) {
    const lines = ['const std = @import("std");'];
    for (const p of cases) {
      const root = rootName(p);
      lines.push(`const case_${p.index} = struct {`, p.bindings.get("zig")!.code.replace(/\bpub const\b/g, "pub const"), "};");
      lines.push("comptime {", `    if (@sizeOf(case_${p.index}.${root}) != ${p.expected.size}) @compileError(std.fmt.comptimePrint("case ${p.index}: size {d}", .{@sizeOf(case_${p.index}.${root})}));`);
      if (!p.expected.union) {
        for (const [name, offset] of kept(p, "zig")) {
          lines.push(`    if (@offsetOf(case_${p.index}.${root}, "${name}") != ${offset}) @compileError(std.fmt.comptimePrint("case ${p.index}: ${name} at {d}", .{@offsetOf(case_${p.index}.${root}, "${name}")}));`);
        }
      }
      lines.push("}");
    }
    const file = join(dir, `zig_${target.replace(/\W+/g, "_")}.zig`);
    writeFileSync(file, lines.join("\n"));
    const [triple, ...flags] = target.split(" ");
    const output = await run("zig", ["build-obj", "-target", triple!, ...flags, "-fno-emit-bin", file], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).then(
      () => "",
      (e: { stderr?: string }) => e.stderr ?? String(e),
    );
    record("zig", cases, output, file);
  }
}

async function checkRust() {
  const byTarget = new Map<string, Prepared[]>();
  for (const p of prepared) {
    const t = bindingTargetName("rust", analyzeStruct("struct S { int a; };", p.target.selection).platform);
    if (!t || p.bindings.get("rust")!.error) continue;
    byTarget.set(t, [...(byTarget.get(t) ?? []), p]);
  }
  for (const [target, cases] of byTarget) {
    const stable = rustTargets.has(target);
    const tier3 = !rustupTargets.has(target);
    if (!stable && !(tier3 && buildStd)) {
      const why = tier3
        ? `rustup ships no core library for ${target} (tier 3); building it needs nightly: rustup toolchain install nightly --profile minimal -c rust-src`
        : `rustup target add ${target}`;
      for (const p of cases) unavailable.get("rust")!.set(p.index, why);
      continue;
    }
    const lines = ["#![no_std]", "#![allow(non_camel_case_types, non_snake_case, dead_code)]"];
    for (const p of cases) {
      const root = rootName(p);
      lines.push(`pub mod case_${p.index} {`, p.bindings.get("rust")!.code, "}", "const _: () = {");
      lines.push(`    assert!(core::mem::size_of::<case_${p.index}::${root}>() == ${p.expected.size}, "case ${p.index}: size");`);
      if (!p.expected.union) {
        for (const [name, offset] of kept(p, "rust")) {
          const field = ["type", "in", "match", "ref", "move", "fn", "loop", "use", "mod", "box", "self"].includes(name) ? `r#${name}` : name;
          lines.push(`    assert!(core::mem::offset_of!(case_${p.index}::${root}, ${field}) == ${offset}, "case ${p.index}: ${name}");`);
        }
      }
      lines.push("};");
    }
    const flags = RUST_FLAGS[target] ?? [];
    const fail = (e: { stderr?: string }) => e.stderr ?? String(e);
    let file: string;
    let output: string;
    if (stable) {
      file = join(dir, `rust_${target}.rs`);
      writeFileSync(file, lines.join("\n"));
      const args = ["--edition", "2021", "--crate-type", "lib", "--target", target, ...flags, "--emit", "metadata", "-o", join(dir, `rust_${target}.rmeta`), file];
      output = await run("rustc", args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).then(() => "", fail);
    } else {
      // A tier-3 target: core built from source on nightly, in buildStdDir.
      const crate = join(dir, `rust_${target}`);
      mkdirSync(join(crate, "src"), { recursive: true });
      writeFileSync(join(crate, "Cargo.toml"), '[package]\nname = "bindcheck"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n');
      file = join(crate, "src", "lib.rs");
      writeFileSync(file, lines.join("\n"));
      const env = { ...process.env, CARGO_TARGET_DIR: buildStdDir, RUSTFLAGS: flags.join(" ") };
      const args = ["run", "nightly", "cargo", "check", "-q", "-Zbuild-std=core", "--target", target];
      output = await run("rustup", args, { cwd: crate, env, maxBuffer: 64 * 1024 * 1024 }).then(() => "", fail);
    }
    record("rust", cases, output, file);
  }
}

async function checkGo() {
  const byArch = new Map<string, Prepared[]>();
  for (const p of prepared) {
    const arch = bindingTargetName("go", analyzeStruct("struct S { int a; };", p.target.selection).platform);
    if (!arch || p.bindings.get("go")!.error) continue;
    byArch.set(arch, [...(byArch.get(arch) ?? []), p]);
  }
  for (const [arch, cases] of byArch) {
    const root = join(dir, `go_${arch}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "go.mod"), "module bindcheck\n\ngo 1.21\n");
    for (const p of cases) {
      const pkg = `case_${p.index}`;
      mkdirSync(join(root, pkg), { recursive: true });
      writeFileSync(join(root, pkg, "binding.go"), p.bindings.get("go")!.code.replace("package bindings", `package ${pkg}`));
      const struct = rootName(p);
      const asserts = [`package ${pkg}`, "", 'import "unsafe"', "", `var x ${struct}`, `var _ = [1]int{}[unsafe.Sizeof(x)-${p.expected.size}]`];
      if (!p.expected.union) for (const [name, offset] of kept(p, "go")) asserts.push(`var _ = [1]int{}[unsafe.Offsetof(x.${["type", "func", "range", "map", "chan", "var", "go"].includes(name) ? `${name}_` : name})-${offset}]`);
      writeFileSync(join(root, pkg, "check.go"), `${asserts.join("\n")}\n`);
    }
    const output = await run("go", ["build", "./..."], { cwd: root, env: { ...process.env, GOOS: "linux", GOARCH: arch, CGO_ENABLED: "0" }, maxBuffer: 64 * 1024 * 1024 }).then(
      () => "",
      (e: { stderr?: string }) => e.stderr ?? String(e),
    );
    for (const p of cases) {
      ran.get("go")!.add(p.index);
      const errors = output.split(/\r?\n/).filter((l) => l.includes(`case_${p.index}/`) || l.includes(`case_${p.index}\\`));
      if (errors.length > 0) failures.get("go")!.set(p.index, errors.join("\n"));
    }
  }
}

async function checkPython() {
  const cases = prepared.filter((p) => !p.bindings.get("python-struct")!.error);
  const script = [
    "import json, re, struct, ctypes",
    "def offsets(fmt, names):",
    "    order, out, prefix, it = fmt[0], {}, fmt[0], iter(names)",
    "    for count, code in re.findall(r'(\\d*)([a-zA-Z?])', fmt[1:]):",
    "        n = int(count or 1)",
    "        if code == 'x':",
    "            prefix += f'{n}x'",
    "        elif code == 's':",
    "            out[next(it)] = struct.calcsize(prefix); prefix += f'{n}s'",
    "        else:",
    "            for _ in range(n):",
    "                out[next(it)] = struct.calcsize(prefix); prefix += code",
    "    return out",
    "results = {}",
  ];
  for (const p of cases) {
    const root = rootName(p);
    const constant = root.toUpperCase();
    script.push(
      `results[${p.index}] = {}`,
      "try:",
      `    ns = {}`,
      `    exec(${JSON.stringify(p.bindings.get("python-struct")!.code)}, ns)`,
      `    results[${p.index}]['struct'] = {'size': struct.calcsize(ns['${constant}_FORMAT']), 'offsets': offsets(ns['${constant}_FORMAT'], ns['${constant}_FIELDS'])}`,
      "except Exception as e:",
      `    results[${p.index}]['struct'] = {'error': repr(e)}`,
      "try:",
      `    ns2 = {}`,
      `    exec(${JSON.stringify(p.bindings.get("python-ctypes")!.code)}, ns2)`,
      `    c = ns2['${root}']`,
      `    results[${p.index}]['ctypes'] = {'size': ctypes.sizeof(c), 'offsets': {f[0]: getattr(c, f[0]).offset for f in c._fields_}}`,
      "except Exception as e:",
      `    results[${p.index}]['ctypes'] = {'error': repr(e)}`,
    );
  }
  script.push("print(json.dumps(results))");
  const file = join(dir, "check.py");
  writeFileSync(file, script.join("\n"));
  const { stdout } = await run(PYTHON, [file], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  const results = JSON.parse(stdout) as Record<string, Record<"struct" | "ctypes", { size: number; offsets: Record<string, number>; error?: string }>>;
  for (const p of cases) {
    for (const language of ["python-struct", "python-ctypes"] as const) {
      ran.get(language)!.add(p.index);
      const got = results[p.index]![language === "python-struct" ? "struct" : "ctypes"];
      if (got.error) {
        failures.get(language)!.set(p.index, got.error);
        continue;
      }
      const offsets: Record<string, number> = {};
      for (const [name] of kept(p, language)) {
        // struct flattens: an array or record member starts where its first value does.
        const keys = Object.keys(got.offsets).filter((k) => k === name || k.startsWith(`${name}[`) || k.startsWith(`${name}.`));
        if (keys.length > 0) offsets[name] = Math.min(...keys.map((k) => got.offsets[k]!));
      }
      const want = { size: p.expected.size, offsets: p.expected.union ? {} : Object.fromEntries(kept(p, language)) };
      const have = { size: got.size, offsets: p.expected.union ? {} : offsets };
      if (JSON.stringify(sortKeys(have)) !== JSON.stringify(sortKeys(want))) failures.get(language)!.set(p.index, `got ${JSON.stringify(have)}`);
    }
  }
}

async function checkCSharp() {
  const cases = prepared.filter((p) => !p.bindings.get("csharp")!.error);
  const root = join(dir, "csharp");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "check.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework><AllowUnsafeBlocks>true</AllowUnsafeBlocks><Nullable>disable</Nullable><ImplicitUsings>disable</ImplicitUsings><NoWarn>CS0649;CS0169</NoWarn></PropertyGroup></Project>',
  );
  const lines: string[] = [];
  const main = ["public static class Program", "{", "    public static void Main()", "    {"];
  for (const p of cases) {
    const ns = `Case${p.index}`;
    lines.push(`namespace ${ns}`, "{", p.bindings.get("csharp")!.code, "}");
    const t = `${ns}.${rootName(p)}`;
    const fields = p.expected.union ? [] : kept(p, "csharp");
    main.push(
      `        System.Console.WriteLine("${p.index} " + System.Runtime.CompilerServices.Unsafe.SizeOf<${t}>()${fields
        .map(([name]) => ` + " ${name}=" + System.Runtime.InteropServices.Marshal.OffsetOf<${t}>(${JSON.stringify(csharpField(p, name))})`)
        .join("")});`,
    );
  }
  main.push("    }", "}");
  writeFileSync(join(root, "Bindings.cs"), lines.join("\n"));
  writeFileSync(join(root, "Program.cs"), main.join("\n"));
  const output = await run("dotnet", ["run", "-c", "Release"], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 }).then(
    (r) => r.stdout,
    (e: { stdout?: string; stderr?: string }) => `BUILD FAILED\n${e.stdout ?? ""}${e.stderr ?? ""}`,
  );
  for (const p of cases) {
    ran.get("csharp")!.add(p.index);
    if (output.startsWith("BUILD FAILED")) {
      failures.get("csharp")!.set(p.index, output.split(/\r?\n/).filter((l) => l.includes("error")).slice(0, 8).join("\n"));
      continue;
    }
    const line = output.split(/\r?\n/).find((l) => l.startsWith(`${p.index} `));
    const [size, ...pairs] = (line ?? "").split(" ").slice(1);
    const have = { size: Number(size), offsets: Object.fromEntries(pairs.map((x) => x.split("=")).map(([k, v]) => [k!, Number(v)])) };
    const want = { size: p.expected.size, offsets: Object.fromEntries(p.expected.union ? [] : kept(p, "csharp")) };
    if (JSON.stringify(sortKeys(have)) !== JSON.stringify(sortKeys(want))) failures.get("csharp")!.set(p.index, `got ${JSON.stringify(have)}`);
  }
}

/** The C# field a member becomes: an array of records is one field per element. */
function csharpField(p: Prepared, name: string): string {
  const entry = p.result.members.find((m) => m.member.name === name)!;
  const arrayOfRecords = entry.member.arraySize !== undefined && entry.member.isNested && !entry.member.type.includes("*");
  return arrayOfRecords ? `${name}_0` : name === rootName(p) ? `${name}_` : name;
}

const sortKeys = (v: { size: number; offsets: Record<string, number> }) => ({ size: v.size, offsets: Object.fromEntries(Object.entries(v.offsets).sort(([a], [b]) => a.localeCompare(b))) });

/** Map compiler errors to the cases whose lines they are on, or whose check names them. */
function record(language: BindingLanguage, cases: Prepared[], output: string, file: string) {
  for (const p of cases) ran.get(language)!.add(p.index);
  if (!output) return;
  const source = readFileSync(file, "utf8").split(/\r?\n/);
  const caseAt = (line: number) => {
    for (let k = line - 1; k >= 0; k--) {
      const m = /case_(\d+)/.exec(source[k]!);
      if (m) return Number(m[1]);
    }
    return undefined;
  };
  const lines = output.split(/\r?\n/);
  lines.forEach((l, k) => {
    const named = /case (\d+):/.exec(l);
    const at = /:(\d+):\d+/.exec(l) ?? /--> [^:]+:(\d+):/.exec(lines[k + 1] ?? "");
    const index = named ? Number(named[1]) : at && /error/.test(l) ? caseAt(Number(at[1])) : undefined;
    if (index !== undefined) {
      const map = failures.get(language)!;
      map.set(index, `${map.get(index) ?? ""}${l}\n`);
    }
  });
  // An error no case can be blamed for fails them all.
  if (failures.get(language)!.size === 0) for (const p of cases) failures.get(language)!.set(p.index, output.slice(0, 2000));
}

const CHECKERS: Record<BindingLanguage, { available: boolean; check: () => Promise<void> }> = {
  zig: { available: toolchains.zig, check: checkZig },
  rust: { available: toolchains.rust, check: checkRust },
  go: { available: toolchains.go, check: checkGo },
  csharp: { available: toolchains.dotnet, check: checkCSharp },
  "python-struct": { available: toolchains.python, check: async () => {} },
  "python-ctypes": { available: toolchains.python, check: checkPython },
};

for (const language of LANGUAGES) {
  const checker = CHECKERS[language];
  if (!checker.available) {
    if (requireToolchains) it(`${language} toolchain is installed`, () => expect.fail(`no ${language} toolchain`));
    continue;
  }
  describe(`${language} bindings`, () => {
    beforeAll(async () => {
      failures.set(language, failures.get(language) ?? new Map());
      ran.set(language, ran.get(language) ?? new Set());
      unavailable.set(language, unavailable.get(language) ?? new Map());
      if (language === "python-struct") {
        failures.set("python-ctypes", failures.get("python-ctypes") ?? new Map());
        ran.set("python-ctypes", ran.get("python-ctypes") ?? new Set());
        await checkPython();
      } else if (language !== "python-ctypes" || !ran.get("python-ctypes")!.size) {
        await checker.check();
      }
    }, 900_000);

    for (const p of prepared) {
      it(`${p.target.name}: ${p.label}`, (ctx) => {
        const binding = p.bindings.get(language)!;
        if (binding.error) {
          ctx.skip(binding.error);
          return;
        }
        if (!ran.get(language)!.has(p.index)) {
          const why = unavailable.get(language)!.get(p.index) ?? `no ${language} compiler for this target here`;
          if (requireToolchains) expect.fail(`not checked: ${why}`);
          ctx.skip(why);
          return;
        }
        expect(failures.get(language)!.get(p.index), binding.code).toBeUndefined();
      });
    }
  });
}
