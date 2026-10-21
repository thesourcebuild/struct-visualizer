import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeRust, generateRustVerificationModule, rustExamples } from "@sp/core";
import type { CalculationResult, RustAnalysis } from "@sp/core";

/**
 * Ground truth for Rust, from the installed rustc:
 * - x86_64-pc-windows-msvc (the host): every case is a module of one crate whose generated
 *   verification code prints size, align, each field's offset and size, and Option<T>'s size.
 * - thumbv7em-none-eabihf (32-bit, no_std): the same facts as compile-time assertions;
 *   `const _: [(); EXPECTED] = [(); ACTUAL]` fails with both numbers in the message.
 *
 * Skips when rustc (or a target's standard library) is missing.
 */
const run = promisify(execFile);

function installedTargets(): string[] {
  try {
    return execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  } catch {
    try {
      execFileSync("rustc", ["--version"], { stdio: "ignore" });
      return [execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)![1]!];
    } catch {
      return [];
    }
  }
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

/** Cases that need std (not available on no_std targets). */
const STD_ONLY = ["hash collections", "Cow", "64-bit atomics"];

const NO_STD_PRELUDE = [
  "use alloc::boxed::Box;",
  "use alloc::vec::Vec;",
  "use alloc::string::String;",
  "use alloc::rc::Rc;",
  "use alloc::sync::Arc;",
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

const targets = installedTargets();
const entries = Object.entries(CASES);

describe("Rust layouts", () => {
  it("every case is laid out without errors", () => {
    for (const [label, code] of entries) {
      for (const t of ["x86_64-pc-windows-msvc", "thumbv7em-none-eabihf"]) {
        const a = analyzeRust(code, t);
        expect(a.errors.map((e) => e.message), `${label} on ${t}`).toEqual([]);
      }
    }
  });

  describe.skipIf(!targets.includes("x86_64-pc-windows-msvc") || process.platform !== "win32" || process.arch !== "x64")(
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

  describe.skipIf(!targets.includes("thumbv7em-none-eabihf"))("match rustc on thumbv7em-none-eabihf (compile-time checks)", () => {
    it("all cases", async () => {
      const lines: string[] = ["#![no_std]", "extern crate alloc;"];
      const where: string[] = [];
      const note = (text: string) => {
        where[lines.length + 1] = text;
      };
      entries.forEach(([label, code], i) => {
        if (STD_ONLY.includes(label)) return;
        const a = analyzeRust(code, "thumbv7em-none-eabihf");
        const f = facts(a);
        const root = a.definition!.name;
        // no_std: std paths that core also has.
        const coreCode = code.replace(/\bstd::(?=(num|cell|mem|marker|cmp|time|sync::atomic|ffi|fmt|convert|ops|ptr)\b)/g, "core::");
        lines.push(`#[allow(dead_code, unused_imports)]`, `mod case${i} {`, NO_STD_PRELUDE, coreCode);
        note(`${label}: size_of::<${root}>()`);
        lines.push(`const _: [(); ${f.size}] = [(); core::mem::size_of::<${root}>()];`);
        note(`${label}: align_of::<${root}>()`);
        lines.push(`const _: [(); ${f.align}] = [(); core::mem::align_of::<${root}>()];`);
        for (const field of f.fields) {
          note(`${label}: offset_of!(${root}, ${field.name})`);
          lines.push(`const _: [(); ${field.offset}] = [(); core::mem::offset_of!(${root}, ${field.name})];`);
        }
        note(`${label}: size_of::<Option<${root}>>()`);
        lines.push(`const _: [(); ${f.option}] = [(); core::mem::size_of::<Option<${root}>>()];`);
        lines.push("}");
      });
      const dir = mkdtempSync(join(tmpdir(), "sp-rust-thumb-"));
      const src = join(dir, "lib.rs");
      writeFileSync(src, lines.join("\n"));
      const result = await run("rustc", [
        "--edition", "2021", "--crate-type", "lib", "--emit", "metadata", "--target", "thumbv7em-none-eabihf",
        "-A", "warnings", "--out-dir", dir, src,
      ]).then(
        () => "",
        (err: { stderr?: string }) => err.stderr ?? String(err),
      );
      // One block per error; a mismatch names both numbers: "expected ... size of MODEL, found ... RUSTC".
      const mismatches = result
        .split(/^(?=error)/m)
        .map((block) => {
          const at = /lib\.rs:(\d+):\d+/.exec(block);
          const sizes = /size of (\d+), found one with a size of (\d+)/.exec(block);
          return at && sizes ? `${where[Number(at[1])] ?? `line ${at[1]}`}: model ${sizes[1]}, rustc ${sizes[2]}` : undefined;
        })
        .filter((m): m is string => m !== undefined);
      expect(mismatches.length > 0 ? mismatches : result.includes("error") ? [result.slice(0, 3000)] : []).toEqual([]);
    }, 600_000);
  });
});
