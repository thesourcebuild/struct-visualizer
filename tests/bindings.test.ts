import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PaddingCalculator, analyzeStruct, bindingTargetName, examples, generateBindings, goExportedName } from "@sp/core";
import type { BindingLanguage, BindingOutput, CalculationResult, PlatformSelection } from "@sp/core";
import { References, digest, useReferences } from "./support/references";
import type { Answer } from "./support/references";

/**
 * Every binding the Bindings tool writes is compiled by its language and its layout read back
 * there: the size of the struct and the offset of each of its members must be the C layout's on
 * that target. Zig and Rust check at compile time for the target itself; Go for each GOARCH;
 * Python's struct and ctypes and C#'s explicit layout do not depend on the machine, so they run
 * here.
 *
 * Each binding's own layout checks are compiled with it, and its round-trip example runs: for every
 * target in Python and C#; in Rust, Zig and Go for this machine's own target, and is compiled for
 * the others where the toolchain can (Rust where std is installed, Zig where its test runner builds,
 * Go for every GOARCH with go vet). The Go files must be as gofmt formats them.
 *
 * Rust: with the stable compiler for the targets rustup ships a standard library for (rustup
 * target add), and by building core from source on nightly (-Zbuild-std) for the tier-3 targets it
 * ships none for (MIPS, AVR). SP_REQUIRE_BINDING_TOOLCHAINS makes a target left unchecked a failure.
 *
 * A binding no toolchain here can compile is checked against what its compiler confirmed when it
 * last compiled that same code (tests/references/bindings.json, see ./support/references.ts).
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
/** The target rustc runs on: the bindings' tests for it run here. */
const rustHost = toolchains.rust ? /^host: (\S+)/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1] : undefined;
/** Whether the standard library is installed for a target, which its tests need. */
const rustSysroot = toolchains.rust ? execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim() : "";
const rustStd = (target: string) => {
  const lib = join(rustSysroot, "lib", "rustlib", target, "lib");
  return existsSync(lib) && readdirSync(lib).some((f) => /^libstd-.*\.rlib$/.test(f));
};
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
  // Bytes the examples fill with a loop: a run of bit-fields over 16 bytes, and a union of 300
  // (whose values go past 255).
  "wide bit-field run": "struct S { unsigned long long a : 60; unsigned long long b : 60; unsigned long long c : 60; char t; };",
  "large union": "union U { char buf[300]; int i; };\nstruct S { char a; union U u; };",
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
    // No std of its own: a binding's test declares std, which may not shadow another.
    const lines: string[] = [];
    for (const p of cases) {
      const root = rootName(p);
      lines.push(`const case_${p.index} = struct {`, p.bindings.get("zig")!.code, "};");
      lines.push("comptime {", `    if (@sizeOf(case_${p.index}.${root}) != ${p.expected.size}) @compileError(@import("std").fmt.comptimePrint("case ${p.index}: size {d}", .{@sizeOf(case_${p.index}.${root})}));`);
      if (!p.expected.union) {
        for (const [name, offset] of kept(p, "zig")) {
          lines.push(`    if (@offsetOf(case_${p.index}.${root}, "${name}") != ${offset}) @compileError(@import("std").fmt.comptimePrint("case ${p.index}: ${name} at {d}", .{@offsetOf(case_${p.index}.${root}, "${name}")}));`);
        }
      }
      lines.push("}");
    }
    // The bindings' own tests, which are in their namespaces: referring to each brings them in.
    lines.push("test {", ...cases.map((p) => `    _ = case_${p.index};`), "}");
    const file = join(dir, `zig_${target.replace(/\W+/g, "_")}.zig`);
    writeFileSync(file, lines.join("\n"));
    const [triple, ...flags] = target.split(" ");
    const zigRun = (args: string[]) =>
      run("zig", args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).then(
        () => "",
        (e: { stdout?: string; stderr?: string }) => `${e.stderr ?? ""}${e.stdout ?? ""}` || String(e),
      );
    const targetArgs = ["-target", triple!, ...flags];
    // A binding for a target with an OS has a test: run on this machine's own architecture and
    // OS, analysed for the others. A bare-metal one has none: its layout checks are compiled.
    const hosted = cases[0]!.target.selection.os !== "none";
    const host = zigHost.length > 0 && triple!.startsWith(`${zigHost}-`);
    const output = hosted
      ? await zigRun(["test", ...targetArgs, ...(host ? [] : ["-fno-emit-bin"]), file])
      : await zigRun(["build-obj", ...targetArgs, "-fno-emit-bin", file]);
    record("zig", cases, output, file);
  }
}

/** This machine's architecture and OS as zig names them (`zig env`), e.g. x86_64-windows. */
const zigHost = (() => {
  if (!toolchains.zig) return "";
  const env = execFileSync("zig", ["env"], { encoding: "utf8" });
  const m = /\.target = "([^".-]+)-([^".-]+)/.exec(env);
  return m ? `${m[1]}-${m[2]}` : "";
})();

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
    // core only, as on a bare-metal target; the bindings' tests need std and its test harness.
    const lines = ["#![cfg_attr(not(test), no_std)]", "#![allow(non_camel_case_types, non_snake_case, dead_code)]"];
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
      const common = ["--edition", "2021", "--target", target, ...flags];
      const rustc = (args: string[]) => run("rustc", [...common, ...args, file], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).then(() => "", fail);
      output = await rustc(["--crate-type", "lib", "--emit", "metadata", "-o", join(dir, `rust_${target}.rmeta`)]);
      // The bindings' tests: run for this machine's own target, type-checked where std is installed.
      if (!output && target === rustHost) {
        const exe = join(dir, `rust_${target}_test${process.platform === "win32" ? ".exe" : ""}`);
        output = await rustc(["--test", "-o", exe]);
        if (!output) output = await run(exe, [], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).then(() => "", (e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ""}${e.stderr ?? ""}`);
      } else if (!output && rustStd(target)) {
        output = await rustc(["--test", "--emit", "metadata", "-o", join(dir, `rust_${target}_test.rmeta`)]);
      }
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
      const binding = p.bindings.get("go")!;
      mkdirSync(join(root, pkg), { recursive: true });
      writeFileSync(join(root, pkg, "binding.go"), binding.code.replace("package bindings", `package ${pkg}`));
      writeFileSync(join(root, pkg, binding.example!.filename), binding.example!.code.replace("package bindings", `package ${pkg}`));
      const struct = goExportedName(rootName(p));
      const asserts = [`package ${pkg}`, "", 'import "unsafe"', "", `var x ${struct}`, `var _ = [1]int{}[unsafe.Sizeof(x)-${p.expected.size}]`];
      if (!p.expected.union) for (const [name, offset] of kept(p, "go")) asserts.push(`var _ = [1]int{}[unsafe.Offsetof(x.${goExportedName(name)})-${offset}]`);
      writeFileSync(join(root, pkg, "check.go"), `${asserts.join("\n")}\n`);
    }
    const go = (args: string[], env: NodeJS.ProcessEnv) =>
      run("go", args, { cwd: root, env: { ...process.env, ...env, CGO_ENABLED: "0" }, maxBuffer: 64 * 1024 * 1024 }).then(
        (r) => r.stdout,
        (e: { stdout?: string; stderr?: string }) => `FAILED\n${e.stdout ?? ""}${e.stderr ?? ""}`,
      );
    const fail = (p: Prepared, why: string) => failures.get("go")!.set(p.index, `${failures.get("go")!.get(p.index) ?? ""}${why}\n`);
    // As gofmt writes them: it lists the files it would change.
    const unformatted = await run("gofmt", ["-l", "."], { cwd: root }).then((r) => r.stdout);
    // Compiled for the GOARCH, the examples too; run on this machine's own.
    const vetted = await go(["vet", "./..."], { GOOS: "linux", GOARCH: arch });
    // Test binaries built into a directory of their own and run from there: go test removes its
    // own, which Windows refuses while a scanner still holds the file.
    let tested = "";
    if (arch === goHost.arch) {
      const bin = join(root, "testbin");
      const built = await go(["test", "-c", "-o", `${bin}/`, "./..."], { GOOS: goHost.os, GOARCH: arch });
      if (built.startsWith("FAILED")) tested = built;
      else {
        for (const p of cases) {
          const exe = join(bin, `case_${p.index}.test${goHost.os === "windows" ? ".exe" : ""}`);
          if (!existsSync(exe)) {
            tested += `FAIL\tbindcheck/case_${p.index}\nno test binary was built\n`;
            continue;
          }
          const out = await run(exe, [], { cwd: join(root, `case_${p.index}`), maxBuffer: 64 * 1024 * 1024 }).then(
            () => "",
            (e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ""}${e.stderr ?? ""}`,
          );
          if (out) tested += `FAIL\tbindcheck/case_${p.index}\n${out}\n`;
        }
      }
    }
    for (const p of cases) {
      ran.get("go")!.add(p.index);
      const pkg = `case_${p.index}`;
      const mine = (l: string) => l.includes(`${pkg}/`) || l.includes(`${pkg}\\`) || l.endsWith(`/${pkg}`) || new RegExp(`/${pkg}\\s`).test(l);
      const errors = vetted.split(/\r?\n/).filter(mine);
      if (errors.length > 0) fail(p, errors.join("\n"));
      if (new RegExp(`^FAIL\\s+bindcheck/${pkg}\\b`, "m").test(tested)) fail(p, `go test failed:\n${tested.slice(0, 2000)}`);
      if (unformatted.split(/\r?\n/).some(mine)) fail(p, "not formatted as gofmt formats it");
    }
    // A failure no case can be blamed for fails them all.
    const blamed = cases.some((p) => failures.get("go")!.has(p.index));
    for (const output of [vetted, tested]) {
      const why = output.split(/\r?\n/).filter((l) => !/^ok\s/.test(l)).join("\n").slice(0, 2000);
      if (output.startsWith("FAILED") && !blamed) for (const p of cases) fail(p, why);
    }
  }
}

/** The OS and architecture Go runs on here: the examples for that GOARCH run. */
const goHost = (() => {
  if (!toolchains.go) return { os: "", arch: "" };
  const [os, arch] = execFileSync("go", ["env", "GOHOSTOS", "GOHOSTARCH"], { encoding: "utf8" }).trim().split(/\r?\n/);
  return { os: os!, arch: arch! };
})();

async function checkPython() {
  const cases = prepared.filter((p) => !p.bindings.get("python-struct")!.error);
  const script = [
    "import contextlib, io, json, re, struct, ctypes, traceback",
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
      // Run as a script: its layout checks, then its round trip (whose output is not the answer).
      `    ns = {'__name__': '__main__'}`,
      `    with contextlib.redirect_stdout(io.StringIO()):`,
      `        exec(${JSON.stringify(p.bindings.get("python-struct")!.code)}, ns)`,
      `    results[${p.index}]['struct'] = {'size': struct.calcsize(ns['${constant}_FORMAT']), 'offsets': offsets(ns['${constant}_FORMAT'], ns['${constant}_FIELDS'])}`,
      "except Exception:",
      `    results[${p.index}]['struct'] = {'error': traceback.format_exc(limit=-1)}`,
      "try:",
      `    ns2 = {'__name__': '__main__'}`,
      `    with contextlib.redirect_stdout(io.StringIO()):`,
      `        exec(${JSON.stringify(p.bindings.get("python-ctypes")!.code)}, ns2)`,
      `    c = ns2['${root}']`,
      `    results[${p.index}]['ctypes'] = {'size': ctypes.sizeof(c), 'offsets': {f[0]: getattr(c, f[0]).offset for f in c._fields_}}`,
      "except Exception:",
      `    results[${p.index}]['ctypes'] = {'error': traceback.format_exc(limit=-1)}`,
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
  const main = ["public static class Program", "{", "    public static void Main()", "    {", "        var stdout = System.Console.Out;"];
  for (const p of cases) {
    const ns = `Case${p.index}`;
    const binding = p.bindings.get("csharp")!;
    lines.push(`namespace ${ns}`, "{", binding.code, "}", `namespace ${ns}`, "{", binding.example!.code, "}");
    const t = `${ns}.${rootName(p)}`;
    const fields = p.expected.union ? [] : kept(p, "csharp");
    main.push(
      `        System.Console.WriteLine("${p.index} " + System.Runtime.CompilerServices.Unsafe.SizeOf<${t}>()${fields
        .map(([name]) => ` + " ${name}=" + System.Runtime.InteropServices.Marshal.OffsetOf<${t}>(${JSON.stringify(csharpField(p, name))})`)
        .join("")});`,
      // The round-trip example, its own output set aside.
      "        try",
      "        {",
      "            System.Console.SetOut(System.IO.TextWriter.Null);",
      `            ${ns}.${binding.example!.filename.replace(/\.cs$/, "")}.Run();`,
      "            System.Console.SetOut(stdout);",
      "        }",
      "        catch (System.Exception e)",
      "        {",
      "            System.Console.SetOut(stdout);",
      `            System.Console.WriteLine("${p.index} example: " + e.Message);`,
      "        }",
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
    const example = output.split(/\r?\n/).find((l) => l.startsWith(`${p.index} example: `));
    if (example) failures.get("csharp")!.set(p.index, `${failures.get("csharp")!.get(p.index) ?? ""}${example}\n`);
  }
}

/** The C# field a member becomes: an array of records is one field per element. */
function csharpField(p: Prepared, name: string): string {
  const entry = p.result.members.find((m) => m.member.name === name)!;
  const arrayOfRecords = entry.member.arraySize !== undefined && entry.member.isNested && !entry.member.type.includes("*");
  // A member may not have its struct's name, nor that of the root's FromBytes and ToBytes.
  return arrayOfRecords ? `${name}_0` : name === rootName(p) || name === "FromBytes" || name === "ToBytes" ? `${name}_` : name;
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
    // A check's own message, or a failed test, which zig and Rust name by its path.
    const named = /case (\d+):/.exec(l) ?? (/fail|panicked|^----/i.test(l) ? /\bcase_(\d+)(?:\.test\.|::)/.exec(l) : null);
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

/**
 * What a binding was checked to have when it was compiled: the size and member offsets its
 * compiler confirmed, for the code it was given (a digest), which is the only code they hold for.
 */
interface Confirmed {
  code: string;
  size: number;
  offsets: Record<string, number>;
}
const refs = new References<Confirmed>("bindings");
afterAll(() => refs.save());

for (const language of LANGUAGES) {
  const checker = CHECKERS[language];
  const compile = checker.available && !useReferences;
  if (!checker.available && requireToolchains) it(`${language} toolchain is installed`, () => expect.fail(`no ${language} toolchain`));
  describe(`${language} bindings${compile ? "" : " (recorded answers)"}`, () => {
    beforeAll(async () => {
      failures.set(language, failures.get(language) ?? new Map());
      ran.set(language, ran.get(language) ?? new Set());
      unavailable.set(language, unavailable.get(language) ?? new Map());
      if (!compile) return;
      if (language === "python-struct") {
        failures.set("python-ctypes", failures.get("python-ctypes") ?? new Map());
        ran.set("python-ctypes", ran.get("python-ctypes") ?? new Set());
        await checkPython();
      } else if (language !== "python-ctypes" || !ran.get("python-ctypes")!.size) {
        await checker.check();
      }
    }, 900_000);

    for (const p of prepared) {
      const key = `${language} | ${p.target.name} | ${p.label}`;
      refs.declare(key);
      it(`${p.target.name}: ${p.label}`, (ctx) => {
        const binding = p.bindings.get(language)!;
        if (binding.error) {
          ctx.skip(binding.error);
          return;
        }
        const compiled = ran.get(language)!.has(p.index);
        if (compile && !compiled && requireToolchains) {
          expect.fail(`not checked: ${unavailable.get(language)!.get(p.index) ?? `no ${language} compiler for this target here`}`);
        }
        // What the binding must have: the C layout's size and the offsets of the members it keeps.
        // The digest is of every file the binding is: the example is compiled with it.
        const want: Confirmed = { code: digest(binding.code + (binding.example?.code ?? "")), size: p.expected.size, offsets: Object.fromEntries(p.expected.union ? [] : kept(p, language)) };
        let now: Answer<Confirmed> | undefined;
        if (compiled) {
          const failure = failures.get(language)!.get(p.index);
          now = failure !== undefined ? { rejected: failure } : { layout: want };
        }
        const truth = refs.answer(key, now);
        if ("rejected" in truth) expect.fail(`${truth.rejected}\n${binding.code}`);
        if (!("layout" in truth)) throw new Error("no layout");
        if (truth.layout.code !== want.code) {
          throw new Error(`The ${language} binding changed since its compiler checked it. Record it again with SP_RECORD_REFERENCES=1 and the ${language} toolchain installed.\n${binding.code}`);
        }
        expect(want, binding.code).toEqual(truth.layout);
      });
    }
  });
}

describe("binding notes", () => {
  const notes = (code: string, selection: PlatformSelection) => {
    const analysis = analyzeStruct(code, selection);
    return generateBindings(analysis.result!, analysis.platform, new PaddingCalculator(analysis.platform.architecture, analysis.platform.dataModel), "csharp").notes;
  };
  const be = TARGETS.find((t) => t.name === "PowerPC 32 Linux")!.selection;
  const le = TARGETS.find((t) => t.name === "x86-64 Linux")!.selection;
  const byteOrder = /machine's byte order/;

  it("C# says when a big-endian target's multi-byte fields need their bytes reversed", () => {
    expect(notes("struct S { char a; int b; };", be).some((n) => byteOrder.test(n))).toBe(true);
    expect(notes("struct S { char a; short b[2]; };", be).some((n) => byteOrder.test(n))).toBe(true);
    // Single bytes have no byte order, and a little-endian target's data reads as it is.
    expect(notes("struct S { char a; unsigned char b[3]; };", be).some((n) => byteOrder.test(n))).toBe(false);
    expect(notes("struct S { char a; int b; };", le).some((n) => byteOrder.test(n))).toBe(false);
  });
});
