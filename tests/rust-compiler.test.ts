import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUST_TARGETS, analyzeRust, formatRustType, generateRustVerificationModule, rustExamples } from "@sp/core";
import type { CalculationResult, RustAnalysis } from "@sp/core";
import { References, useReferences } from "./support/references";
import type { Answer } from "./support/references";

/**
 * Ground truth for Rust, from rustc:
 * - every target: size, align, each field's offset and Option<T>'s size as compile-time checks,
 *   `const _: [(); MODEL] = [(); RUSTC]`, which fail with both numbers. With the stable compiler
 *   for the targets rustup ships a standard library for, and on nightly with core and alloc built
 *   from source (-Zbuild-std) for the tier-3 one, AVR. no_std targets use core and alloc.
 * - x86_64-pc-windows-msvc (the host, on Windows): the generated verification code, compiled and
 *   run, prints the same facts.
 *
 * A target that cannot be compiled here is checked against rustc's recorded answers
 * (tests/references/rust.json), or fails when SP_REQUIRE_COMPILERS is set.
 */
const run = promisify(execFile);
const requireCompilers = Boolean(process.env.SP_REQUIRE_COMPILERS);

const rustupLines = (args: string[]) => {
  try {
    return execFileSync("rustup", args, { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
};
/** Targets whose standard library is installed for the stable compiler. */
const installed = new Set(rustupLines(["target", "list", "--installed"]));
/** Targets rustup distributes a standard library for; the rest are tier 3. */
const distributed = new Set(rustupLines(["target", "list"]).map((l) => l.replace(/ \(.*\)$/, "")));
/** A nightly toolchain with the library source, to build core and alloc for a tier-3 target. */
const buildStd = rustupLines(["component", "list", "--toolchain", "nightly", "--installed"]).some((l) => l.startsWith("rust-src"));
/** Where cargo keeps the core and alloc it builds (as in tests/bindings.test.ts). */
const buildStdDir = process.env.SP_RUST_BUILD_STD_DIR || join(tmpdir(), "sp-rust-build-std");
/** Targets without std: their crates are no_std and use alloc. */
const NO_STD = new Set(["thumbv7em-none-eabihf", "riscv32imac-unknown-none-elf", "avr-none"]);
/** Targets that need a CPU named (AVR has no default). */
const RUST_FLAGS: Record<string, string[]> = { "avr-none": ["-C", "target-cpu=atmega328p"] };

/** How a target is compiled here, if it can be. */
function compilerFor(target: string): "stable" | "build-std" | undefined {
  if (useReferences) return undefined;
  if (installed.has(target)) return "stable";
  if (!distributed.has(target) && distributed.size > 0 && buildStd) return "build-std";
  return undefined;
}

const CASES: Record<string, string> = {
  ...Object.fromEntries(rustExamples.map((e) => [e.name, e.code])),
  "tuple struct": "struct S(u8, u32, u16);",
  "unit and zero-size fields": "struct U;\nstruct S { a: u8, u: U, m: core::marker::PhantomData<u64>, z: [u64; 0], b: u32 }",
  "niche placement": "struct S { a: u32, b: bool, c: u16, d: u8 }",
  "char and NonZero": "struct S { c: char, n: core::num::NonZeroU16, b: bool, x: u8 }",
  "nested tuples": "struct S { t: (u8, u32, u8), u: (bool, u64), v: () }",
  "arrays and constants": "const N: usize = 3;\nstruct S { a: [u16; N * 2], b: u8, c: [bool; 0], d: [u64; core::mem::size_of::<u32>()], e: [u8; 1 << 2] }",
  "byte arrays grouped by size": "const A: usize = 1 << 4;\nconst B: u8 = -1i8 as u8;\nstruct S { a: [u8; A], b: [u8; B as usize], c: [u8; core::mem::size_of::<u64>() * 2] }",
  "pointers": "struct S { a: &'static str, b: &'static [u8], c: *const u8, d: *mut [u16], e: fn(u8) -> u8, f: &'static dyn core::fmt::Debug, g: u8 }",
  "Option niches": "struct S { a: Option<&'static u8>, b: Option<bool>, c: Option<Option<bool>>, d: Option<char>, e: Option<u32>, f: Option<fn()>, g: Option<core::num::NonZeroU64>, h: Option<Option<Option<u8>>> }",
  "Result layouts": "struct S { a: Result<u32, ()>, c: Result<(), &'static u8>, d: Result<u8, core::convert::Infallible>, e: Result<bool, bool>, f: Result<u16, u8> }",
  "Box Vec String": "struct S { v: Vec<u8>, s: String, b: Box<u8>, bs: Box<str>, ov: Option<Vec<u8>>, os: Option<String>, ob: Option<Box<[u32]>>, d: Box<dyn Fn()> }",
  "Rc Arc Cell": "struct S { r: Rc<u8>, a: Arc<[u8]>, c: core::cell::Cell<bool>, rc: core::cell::RefCell<u16>, oc: Option<core::cell::Cell<bool>>, oa: Option<Arc<u64>> }",
  "Duration": "struct S { d: core::time::Duration, o: Option<core::time::Duration>, f: bool }",
  "atomics": "struct S { flag: core::sync::atomic::AtomicBool, n: core::sync::atomic::AtomicU32, p: core::sync::atomic::AtomicUsize, x: u8, q: core::sync::atomic::AtomicPtr<u8> }",
  "64-bit atomics": "struct S { a: core::sync::atomic::AtomicU64, b: u8, c: core::sync::atomic::AtomicI64 }",
  "hash collections": "use std::collections::{HashMap, HashSet};\nstruct S { m: HashMap<u32, String>, s: HashSet<u64>, f: bool }",
  "alloc collections": "struct S { q: VecDeque<u8>, t: BTreeMap<u32, u32>, h: BinaryHeap<u16>, l: LinkedList<u8>, s: BTreeSet<u8> }",
  "Cow": "use std::borrow::Cow;\nstruct S { a: Cow<'static, str>, b: Option<Cow<'static, [u8]>>, c: u8 }",
  "generics": "struct W<T> { a: T, b: u8 }\nstruct S { x: W<u32>, y: W<(u8, u16)>, z: W<bool> }",
  "type aliases": "type Id = u32;\ntype Pair<T> = (T, T);\nstruct S { a: Id, p: Pair<u8>, b: u64 }",
  "repr(C, packed(2))": "#[repr(C, packed(2))]\nstruct S { a: u8, b: u32, c: u16 }",
  "repr(packed) reorders": "#[repr(packed)]\nstruct S { a: u8, b: u32, c: u16 }",
  "repr(align) on repr(Rust)": "#[repr(align(16))]\nstruct S { a: u8, b: u16 }",
  "repr(transparent)": "#[repr(transparent)]\nstruct W(core::num::NonZeroU32);\nstruct S { a: Option<W>, b: u8 }",
  "union": "union U { a: u32, b: [u8; 6], c: u16 }",
  "union in a struct": "#[repr(C)]\nunion U { a: u16, b: u8 }\nstruct S { u: U, t: u8, o: Option<U> }",
  "c types": "struct S { a: core::ffi::c_int, b: core::ffi::c_long, c: core::ffi::c_char, d: core::ffi::c_double, e: core::ffi::c_short }",
  "recursive via Box": "struct Node { val: i32, next: Option<Box<Node>> }",
  "arrays of options": "struct S { a: [Option<bool>; 3], b: Option<[bool; 2]>, c: Option<[u8; 0]>, d: Option<core::cmp::Ordering> }",
  // Enums
  "fieldless enum": "enum E { A, B, C }",
  "wide discriminants": "enum E { A = 10, B = 300 }",
  "negative discriminants": "enum E { A = -1, B = 1 }",
  "repr(C) fieldless enum": "#[repr(C)]\nenum E { A, B }",
  "repr(u32) enum": "#[repr(u32)]\nenum E { A, B }",
  "repr(i64) enum": "#[repr(i64)]\nenum E { A = -5, B }",
  "tag widening": "enum E { A(u32), B(u16), C }",
  "tagged u64": "enum E { A(u64), B(u8) }",
  "bool niche enum": "enum E { A(bool), B, C }",
  "niche around variants": "enum E { A(u8, bool), B(u8), C }",
  "pointer niche too small": "enum E { A(Box<u8>), B, C }",
  "char niche": "enum E { A(char), B, C, D }",
  "jagged variants": "enum E { A { x: u32, f: bool }, B(u16), C }",
  "repr(C) data enum": "#[repr(C)]\nenum E { A(u8), B(u64), C(u16) }",
  "repr(u8) data enum": "#[repr(u8)]\nenum E { A(u64), B(u8) }",
  "repr(C, u16) data enum": "#[repr(C, u16)]\nenum E { A(u8), B(u32) }",
  "absent variant": "enum E { A(core::convert::Infallible), B(u32) }",
  "nested Option enum": "enum E { A(Option<bool>), B }",
  "u128 enum": "enum E { A(u128), B }",
  "enum in struct": "enum K { A, B, C }\nstruct S { k: K, n: u32, o: Option<K> }",
  "Ordering": "struct S { o: core::cmp::Ordering, x: Option<core::cmp::Ordering>, n: u16 }",
};

const NO_STD_PRELUDE = [
  "use alloc::boxed::Box;",
  "use alloc::vec::Vec;",
  "use alloc::string::String;",
  "use alloc::rc::Rc;",
  // alloc has Arc only where the target has pointer-sized atomics (not AVR).
  '#[cfg(target_has_atomic = "ptr")] use alloc::sync::Arc;',
  "use alloc::collections::{VecDeque, BTreeMap, BTreeSet, BinaryHeap, LinkedList};",
].join("\n");
const STD_PRELUDE = "use std::rc::Rc;\nuse std::sync::Arc;\nuse std::collections::{VecDeque, BTreeMap, BTreeSet, BinaryHeap, LinkedList};";

interface Facts {
  size: number;
  align: number;
  fields: Array<{ name: string; offset: number; size: number }>;
  option: number;
}

function facts(a: RustAnalysis): Facts {
  const r = a.result as CalculationResult;
  const item = a.file.items.get(a.definition!.name)!;
  const isRecord = item.kind === "struct" || item.kind === "union";
  return {
    size: r.totalSize,
    align: r.struct.alignment ?? 1,
    fields: isRecord
      ? item.fields.map((f) => {
          const m = r.members.find((x) => x.member.name === f.name)!;
          return { name: f.name, offset: m.offset, size: m.size };
        })
      : [],
    option: a.optionSize!,
  };
}

/** The checks for a case the engine cannot lay out: rustc's numbers, whatever they are, are the answer. */
function unknownFacts(a: RustAnalysis): Facts {
  const item = a.definition ? a.file.items.get(a.definition.name) : undefined;
  const fields = item && (item.kind === "struct" || item.kind === "union") ? item.fields : [];
  return { size: 0, align: 0, fields: fields.map((f) => ({ name: f.name, offset: 0, size: 0 })), option: 0 };
}

/** The root's field types as written, for size_of checks. */
function fieldTypes(a: RustAnalysis): string[] {
  const item = a.definition ? a.file.items.get(a.definition.name) : undefined;
  return item && (item.kind === "struct" || item.kind === "union") ? item.fields.map((f) => formatRustType(f.type)) : [];
}

function parseReport(out: string): Facts {
  const head = /size (\d+), align (\d+)/.exec(out)!;
  return {
    size: Number(head[1]),
    align: Number(head[2]),
    fields: [...out.matchAll(/^\s+(\S+)\s+offset:\s+(\d+)\s+size:\s+(\d+)/gm)].map((m) => ({
      name: m[1]!,
      offset: Number(m[2]),
      size: Number(m[3]),
    })),
    option: Number(/Option<\w+>: size (\d+)/.exec(out)![1]),
  };
}

const entries = Object.entries(CASES);

describe("Rust layouts", () => {
  describe.skipIf(compilerFor("x86_64-pc-windows-msvc") !== "stable" || process.platform !== "win32" || process.arch !== "x64")(
    "match rustc on x86_64-pc-windows-msvc (compiled and run)",
    () => {
      let sections: string[] = [];
      beforeAll(async () => {
        const dir = mkdtempSync(join(tmpdir(), "sp-rust-"));
        const modules = entries.map(([, code], i) => {
          const a = analyzeRust(code, "x86_64-pc-windows-msvc");
          return generateRustVerificationModule(`${STD_PRELUDE}\n${code}`, a.definition!.name, a.file, `case${i}`);
        });
        const main = `fn main() {\n${entries.map((_, i) => `    println!("=== ${i}");\n    case${i}::report();`).join("\n")}\n}\n`;
        const src = join(dir, "main.rs");
        writeFileSync(src, `${modules.join("\n")}\n${main}`);
        const bin = join(dir, "verify.exe");
        await run("rustc", ["--edition", "2021", "-A", "warnings", "-o", bin, src]).catch((err: { stderr?: string }) => {
          throw new Error(err.stderr ?? String(err));
        });
        const { stdout } = await run(bin, []);
        sections = stdout.split(/^=== \d+\r?$/m).slice(1);
      }, 600_000);

      entries.forEach(([label, code], i) => {
        it(label, () => {
          const a = analyzeRust(code, "x86_64-pc-windows-msvc");
          expect({ label, ...parseReport(sections[i]!) }).toEqual({ label, ...facts(a) });
        });
      });
    },
  );

});

/** rustc's facts for each case on one target, worked out from its compile-time checks. */
interface Checked {
  answers: Map<number, Answer<Facts>>;
  /** An error no case can be blamed for: no answer to record. */
  failure?: string;
}

interface Case {
  index: number;
  label: string;
  code: string;
  /** The engine's errors: a case it rejects is still compiled, so rustc's answer is known. */
  errors: string[];
  /** The engine's facts, or zeros for a case it rejects. */
  facts: Facts;
  root?: string;
  types: string[];
}

/** A case's source for a no_std target: the std paths that core and alloc also have. */
const forNoStd = (code: string) =>
  code
    .replace(/\bstd::(?=(num|cell|mem|marker|cmp|time|sync::atomic|ffi|fmt|convert|ops|ptr)\b)/g, "core::")
    .replace(/\bstd::borrow\b/g, "alloc::borrow");

/**
 * One crate of compile-time checks for every case on `target`. Each fact is a check against the
 * engine's number; where it fails, rustc names its own, so rustc's whole answer is known either way.
 */
async function checkTarget(target: string, how: "stable" | "build-std", cases: Case[]): Promise<Checked> {
  const noStd = NO_STD.has(target);
  const lines: string[] = noStd ? ["#![no_std]", "extern crate alloc;"] : [];
  /** Per line of the crate: the case and the fact its check is about. */
  const at: Array<{ index: number; fact: string } | undefined> = [];
  const push = (line: string, mark?: { index: number; fact: string }) => {
    lines.push(line);
    at[lines.length] = mark;
  };
  const caseOfLine = (line: number) => {
    for (let k = line; k > 0; k--) if (at[k]) return at[k]!.index;
    return undefined;
  };
  const mem = noStd ? "core::mem" : "std::mem";
  for (const c of cases) {
    const code = noStd ? forNoStd(c.code) : c.code;
    push(`#[allow(dead_code, unused_imports, non_camel_case_types)]`, { index: c.index, fact: "" });
    push(`mod case${c.index} {`, { index: c.index, fact: "" });
    for (const l of `${noStd ? NO_STD_PRELUDE : STD_PRELUDE}\n${code}`.split("\n")) push(l);
    const check = (value: number, expr: string, fact: string) => push(`const _: [(); ${value}] = [(); ${expr}];`, { index: c.index, fact });
    check(c.facts.size, `${mem}::size_of::<${c.root}>()`, "size");
    check(c.facts.align, `${mem}::align_of::<${c.root}>()`, "align");
    c.facts.fields.forEach((f, k) => {
      check(f.offset, `${mem}::offset_of!(${c.root}, ${f.name})`, `offset ${f.name}`);
      check(f.size, `${mem}::size_of::<${c.types[k]}>()`, `size ${f.name}`);
    });
    check(c.facts.option, `${mem}::size_of::<Option<${c.root}>>()`, "option");
    push("}");
  }
  const dir = mkdtempSync(join(tmpdir(), "sp-rust-"));
  const flags = RUST_FLAGS[target] ?? [];
  const fail = (err: { stderr?: string }) => err.stderr ?? String(err);
  let output: string;
  if (how === "stable") {
    const src = join(dir, "lib.rs");
    writeFileSync(src, lines.join("\n"));
    const args = ["--edition", "2021", "--crate-type", "lib", "--emit", "metadata", "--target", target, ...flags, "-A", "warnings", "--out-dir", dir, src];
    output = await run("rustc", args, { maxBuffer: 64 * 1024 * 1024 }).then(() => "", fail);
  } else {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "layoutcheck"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n');
    writeFileSync(join(dir, "src", "lib.rs"), lines.join("\n"));
    const env = { ...process.env, CARGO_TARGET_DIR: buildStdDir, RUSTFLAGS: [...flags, "-A", "warnings"].join(" ") };
    const args = ["run", "nightly", "cargo", "check", "-q", "-Zbuild-std=core,alloc", "--target", target];
    output = await run("rustup", args, { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 }).then(() => "", fail);
  }

  const answers = new Map<number, Answer<Facts>>(cases.map((c) => [c.index, { layout: structuredClone(c.facts) }]));
  let blamed = false;
  for (const block of output.split(/^(?=error)/m)) {
    const where = /lib\.rs:(\d+):\d+/.exec(block);
    if (!where || !/^error/.test(block)) continue;
    const line = Number(where[1]);
    const index = caseOfLine(line);
    if (index === undefined) continue;
    blamed = true;
    const answer = answers.get(index)!;
    const sizes = /size of (\d+), found one with a size of (\d+)/.exec(block);
    const mark = at[line];
    if (sizes && mark && mark.fact && "layout" in answer) {
      // rustc's number for the fact the check is about.
      const value = Number(sizes[2]);
      const facts = answer.layout;
      const [what, name] = mark.fact.split(" ");
      if (mark.fact === "size") facts.size = value;
      else if (mark.fact === "align") facts.align = value;
      else if (mark.fact === "option") facts.option = value;
      else if (what === "offset") facts.fields.find((f) => f.name === name)!.offset = value;
      else facts.fields.find((f) => f.name === name)!.size = value;
    } else if (!("rejected" in answer)) {
      answers.set(index, { rejected: block.split("\n")[0]!.trim() });
    }
  }
  return output && !blamed ? { answers, failure: output.slice(0, 3000) } : { answers };
}

const refs = new References<Facts>("rust");
afterAll(() => refs.save());

for (const target of RUST_TARGETS) {
  const how = compilerFor(target.id);
  if (!how && requireCompilers) {
    it(`rustc can compile for ${target.id}`, () => {
      throw new Error(
        distributed.has(target.id) || distributed.size === 0
          ? `rustup target add ${target.id}`
          : `${target.id} is tier 3: rustup toolchain install nightly --profile minimal -c rust-src`,
      );
    });
    continue;
  }
  describe(`Rust layouts match rustc on ${target.id}${how ? "" : " (recorded answers)"}`, () => {
    const cases: Case[] = entries.map(([label, code], index) => {
      const a = analyzeRust(code, target.id);
      const errors = a.errors.map((e) => e.message);
      return { index, label, code, errors, facts: errors.length === 0 ? facts(a) : unknownFacts(a), root: a.definition?.name, types: fieldTypes(a) };
    });
    let checked: Checked | undefined;

    beforeAll(async () => {
      // A case with no definition (a syntax error) has nothing to compile.
      if (how) checked = await checkTarget(target.id, how, cases.filter((c) => c.root));
    }, 900_000);

    for (const c of cases) {
      it(c.label, () => {
        if (checked?.failure) throw new Error(checked.failure);
        if (!c.root) throw new Error(c.errors.join("; "));
        const truth = refs.answer(`${target.id} | ${c.label}`, checked?.answers.get(c.index));
        if ("rejected" in truth) {
          // What rustc refuses on this target (a type core does not have here), the engine must refuse.
          expect(c.errors.length, `rustc rejects it on ${target.id} (${truth.rejected}); the engine does not`).toBeGreaterThan(0);
          return;
        }
        if (!("layout" in truth)) throw new Error("rustc gave no layout");
        expect(c.errors, `${c.label} on ${target.id}`).toEqual([]);
        expect({ label: c.label, ...c.facts }).toEqual({ label: c.label, ...truth.layout });
      });
    }
  });
}
