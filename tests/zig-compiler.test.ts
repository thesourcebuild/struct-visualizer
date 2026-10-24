import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZIG_TARGETS, ZIG_X86_64_CPUS, analyzeZig, generateZigVerificationModule, zigExamples, zigTargetFlags } from "@sp/core";
import type { ZigAnalysis, ZigBuildMode } from "@sp/core";
import { References, useReferences } from "./support/references";
import type { Answer } from "./support/references";

/**
 * Ground truth for Zig, from the installed compiler (0.16):
 * - every case on every target, in Debug, ReleaseSafe and ReleaseFast (which differ in the safety
 *   tag of bare unions, in std types holding a SafetyLock, and in the code generator that lays
 *   out vectors): size, alignment, the size of ?T and each field's @offsetOf (@bitOffsetOf for
 *   packed structs), checked at compile time with `zig build-obj -fno-emit-bin`, which names the
 *   compiler's values on a mismatch;
 * - the verification program the Zig Verification Code tool generates, built and run for the host.
 *
 * Without zig, the layouts are checked against its recorded answers (tests/references/zig.json);
 * SP_REQUIRE_COMPILERS makes a missing zig a failure.
 */
const run = promisify(execFile);
const requireZig = Boolean(process.env.SP_REQUIRE_COMPILERS);

let zig = false;
try {
  zig = execFileSync("zig", ["version"], { encoding: "utf8" }).trim().startsWith("0.16");
} catch {
  zig = false;
}

const fields = (n: number, gen: (i: number) => string) => Array.from({ length: n }, (_, i) => gen(i)).join(", ");
const TYPES = ["u8", "u16", "u32", "u64", "bool", "u24", "i48", "f32", "u128", "[3]u8", "?u16", "[2]u32"];

const CASES: Record<string, string> = {
  ...Object.fromEntries(zigExamples.map((e) => [e.name, e.code])),
  // Field order: the compiler's pdq sort, through insertion sort (up to 24 fields) and beyond.
  "equal alignments": "const S = struct { a: u8, b: u32, c: u8, d: u32, e: u16, f: u8, g: u16 };",
  "30 fields": `const S = struct { ${fields(30, (i) => `f${i}: ${TYPES[(i * 7) % TYPES.length]}`)} };`,
  "60 fields": `const S = struct { ${fields(60, (i) => `f${i}: ${TYPES[(i * 5 + 3) % TYPES.length]}`)} };`,
  "100 fields, many equal": `const S = struct { ${fields(100, (i) => `f${i}: ${["u8", "u64", "u16", "u32"][(i * i) % 4]}`)} };`,
  "zero-size fields": "const E = struct {};\nconst S = struct { a: u8, v: void, z: u0, b: u32, e: E, arr: [0]u64, c: u16 };",
  "comptime field": "const S = struct { a: u8, comptime tag: u32 = 7, b: u64, c: u8 };",
  "field alignments": "const S = struct { a: u8, b: u8 align(8), c: u32 align(2), d: u16, e: u8 align(16) };",
  "tuple": "const T = struct { u8, u32, u8, void, u16 };",
  "integers of any width": "const S = struct { a: u24, b: u48, c: i65, d: u7, e: u256, f: u1, g: i17 };",
  "floats": "const S = struct { a: f16, b: f80, c: f128, d: f32, e: f64, f: c_longdouble, g: u8 };",
  "c types": "const S = extern struct { a: c_char, b: c_short, c: c_int, d: c_long, e: c_longlong, f: c_ulong, g: c_longdouble, h: u8 };",
  "extern 128-bit integers": "const S = extern struct { a: u8, b: u128, c: u8, d: i128 };",
  "pointers and slices": "const S = struct { a: *u8, b: [*]u16, c: []const u8, d: [*c]u32, e: [:0]const u8, f: [*:0]u8, g: *align(16) u8, h: *allowzero u8, i: u8 };",
  "optionals": "const S = struct { a: ?u8, b: ?u32, c: ?*u8, d: ?[]u8, e: ?void, f: ?bool, g: ??u8, h: ?u64, i: ?*allowzero u8, j: ?[*c]u8, k: ?anyerror, l: ?[3]u16 };",
  "error unions": "const E = error{ A, B };\nconst S = struct { a: anyerror!u8, b: E!u64, c: anyerror!void, d: E!?u32, e: anyerror![3]u8, f: E, g: anyerror };",
  "sentinel arrays": "const S = struct { a: [3:0]u8, b: [2:0]u32, c: [0:0]u16, d: u8 };",
  "vectors": "const S = struct { a: @Vector(3, f32), b: @Vector(5, u8), c: @Vector(16, bool), d: @Vector(2, u64), e: @Vector(8, f64), f: u8, g: @Vector(3, u7) };",
  "enums": "const A = enum { x };\nconst B = enum { x, y, z };\nconst C = enum(u16) { x = 300, y };\nconst D = enum(i8) { x = -1, y, _ };\nconst S = struct { a: A, b: B, c: C, d: D, e: u8 };",
  "enum of 257 fields": `const E = enum { ${fields(257, (i) => `v${i}`)} };\nconst S = struct { e: E, b: u8 };`,
  "enum root": "const E = enum(u32) { a = 1, b = 1 << 20 };",
  "bare union": "const U = union { a: u32, b: u8, c: [5]u8 };",
  "bare union of one field": "const U = union { a: u64 };",
  "tagged union": "const U = union(enum) { a: u64, b: u8, c: void };",
  "tagged union, payload more aligned": "const U = union(enum) { a: [5]u8, b: u32 };",
  "tagged union, explicit tag type": "const U = union(enum(u32)) { a: u8, b: u16 };",
  "union with an enum tag": "const Tag = enum(u8) { int, float, none };\nconst U = union(Tag) { int: i64, float: f32, none: void };",
  "union of void fields": "const U = union(enum) { a, b, c };",
  "extern union": "const U = extern union { a: u8, b: c_int, c: [6]u8, d: f64 };",
  "packed struct": "const P = packed struct { a: u3, b: bool, c: u9, d: i4 };",
  "packed struct, explicit backing": "const P = packed struct(u32) { lo: u16, hi: u16 };",
  "packed struct of 65 bits": "const P = packed struct { a: u64, b: bool };",
  "nested packed": "const Mode = enum(u2) { a, b, c, d };\nconst Inner = packed struct { x: u3, m: Mode };\nconst P = packed struct { flag: bool, inner: Inner, rest: u10 };",
  "packed struct in a struct": "const P = packed struct { a: u4, b: u4 };\nconst S = struct { x: u32, p: P, y: u8 };",
  "packed union": "const U = packed union { a: u16, b: i16, c: packed struct { lo: u8, hi: u8 } };",
  "extern with packed and enum": "const F = packed struct(u8) { a: bool, b: u7 };\nconst E = enum(c_int) { x, y };\nconst S = extern struct { f: F, e: E, p: ?*anyopaque, q: [2]F };",
  "function pointers": "const S = struct { a: *const fn () void, b: ?*const fn (u32) callconv(.c) u32, c: u8 };",
  "constants and builtins": "const N = 4;\nconst Hdr = struct { a: u8, b: u32 };\nconst S = struct { buf: [N * 2 + 1]u8, h: [@sizeOf(Hdr)]u8, al: [@alignOf(u64)]u16, bits: [@bitSizeOf(u12)]u8, m: [@max(3, N)]u8, d: [@divExact(12, 4)]u8 };",
  "generic with @This": "fn List(comptime T: type) type {\n    return struct {\n        const Self = @This();\n        head: ?*Node,\n        len: usize,\n        const Node = struct { value: T, next: ?*Node };\n    };\n}\nconst S = struct { a: List(u8), b: List(u64), c: u8 };",
  "generic with if": "fn Small(comptime n: comptime_int) type {\n    if (n <= 255) return u8;\n    return u32;\n}\nconst S = struct { a: Small(10), b: Small(1000), c: u16 };",
  "nested declarations": "const Outer = struct {\n    pub const Inner = struct { x: u16, y: u8 };\n    a: Inner,\n    b: u64,\n};\nconst S = struct { o: Outer, i: Outer.Inner };",
  "@Int and std.meta.Int": "const std = @import(\"std\");\nconst S = struct { a: @Int(.unsigned, 12), b: std.meta.Int(.signed, 40), c: [std.math.maxInt(u4)]u8, d: u8 };",
  "builtin mode": "const builtin = @import(\"builtin\");\nconst S = struct { a: if (builtin.mode == .Debug) u64 else u8, b: u8 };",
  // std types
  "std: ArrayList and Allocator": "const std = @import(\"std\");\nconst S = struct { a: std.ArrayList(u8), b: std.ArrayListUnmanaged(u32), c: std.array_list.Managed(u16), d: std.mem.Allocator, e: u8 };",
  "std: hash maps": "const std = @import(\"std\");\nconst S = struct { a: std.AutoHashMap(u32, u64), b: std.StringHashMap(u8), c: std.AutoHashMapUnmanaged(u8, u8), d: std.StringHashMapUnmanaged(void), e: u8 };",
  "std: MultiArrayList and atomics": "const std = @import(\"std\");\nconst P = struct { x: f32, y: u8 };\nconst S = struct { a: std.MultiArrayList(P), b: std.atomic.Value(u32), c: std.atomic.Value(u64), d: std.atomic.Value(bool), e: u8 };",
  "std: Io sync": "const std = @import(\"std\");\nconst S = struct { m: std.Io.Mutex, c: std.Io.Condition, s: std.Io.Semaphore, r: std.Io.RwLock, f: u8 };",
  "std: Io Writer and Reader": "const std = @import(\"std\");\nconst S = struct { w: std.Io.Writer, r: std.Io.Reader, b: bool };",
  "std: linked lists and Random": "const std = @import(\"std\");\nconst S = struct { d: std.DoublyLinkedList, dn: std.DoublyLinkedList.Node, s: std.SinglyLinkedList, sn: std.SinglyLinkedList.Node, r: std.Random, f: u8 };",
  "std: bit sets": "const std = @import(\"std\");\nconst S = struct { a: std.StaticBitSet(10), b: std.StaticBitSet(64), c: std.StaticBitSet(100), d: std.bit_set.IntegerBitSet(3), e: u8 };",
  "std: aligned lists and Log2Int": "const std = @import(\"std\");\nconst S = struct { a: std.ArrayListAligned(u8, .@\"16\"), b: std.ArrayListAligned(u32, .@\"4\"), c: std.array_list.AlignedManaged(u16, .@\"8\"), d: std.math.Log2Int(u64), e: std.math.Log2Int(u8), f: std.mem.Alignment, g: std.Io.Limit };",
  "switch and captures": "fn Pick(comptime n: comptime_int) type {\n    return switch (n) {\n        0 => void,\n        1...8 => u8,\n        9, 10 => u16,\n        else => u64,\n    };\n}\nfn Or(comptime T: ?type) type {\n    if (T) |t| return t;\n    return u32;\n}\nconst S = struct { a: Pick(0), b: Pick(5), c: Pick(10), d: Pick(100), e: Or(u8), f: Or(null) };",
  "typed comptime integers": "const bits: u16 = 12;\nconst W = @Int(.unsigned, 16 - @clz(bits - 1));\nconst S = struct { a: W, b: [@popCount(@as(u8, 0b1011))]u8, c: [@ctz(@as(u32, 8))]u16, d: u8 };",
  "std: PriorityQueue": "const std = @import(\"std\");\nfn lessThan(_: void, a: u32, b: u32) std.math.Order {\n    return std.math.order(a, b);\n}\nconst S = struct { q: std.PriorityQueue(u32, void, lessThan), f: u8 };",
};

const MODES: ZigBuildMode[] = ["Debug", "ReleaseSafe", "ReleaseFast"];

interface Prepared {
  index: number;
  label: string;
  code: string;
  target: (typeof ZIG_TARGETS)[number];
  mode: ZigBuildMode;
  /** An x86-64 level other than the baseline, or none. */
  cpu?: string;
  analysis: ZigAnalysis;
  expected: string;
}

/** What the comptime check prints: the same facts the engine computed. */
function facts(a: ZigAnalysis): string {
  const r = a.result!;
  const parts = [`size ${r.totalSize}`, `align ${r.struct.alignment}`, `opt ${a.optionalSize}`];
  for (const o of a.offsets) parts.push(`${o.name} ${o.bitOffset ?? o.offset}`);
  return parts.join(" ");
}

function check(p: Prepared): string[] {
  const T = `case_${p.index}.${p.analysis.definition!.name}`;
  const pieces: [string, string][] = [
    ["size", `@sizeOf(${T})`],
    ["align", `@alignOf(${T})`],
    ["opt", `@sizeOf(?${T})`],
    ...p.analysis.offsets.map((o): [string, string] => [o.name, o.bitOffset !== undefined ? `@bitOffsetOf(${T}, "${o.name}")` : `@offsetOf(${T}, "${o.name}")`]),
  ];
  // One fact per comptimePrint: it takes at most 32 arguments.
  const actual = pieces.map(([label, e]) => `@import("std").fmt.comptimePrint("${label} {d}", .{${e}})`).join(' ++ " " ++ ');
  return [
    "comptime {",
    "    @setEvalBranchQuota(1000000);",
    `    const actual = ${actual};`,
    `    if (!@import("std").mem.eql(u8, actual, "${p.expected}")) @compileError("case ${p.index}: " ++ actual);`,
    "}",
  ];
}

/**
 * The CPU levels checked on each target: on x86-64 Linux, whose Debug builds use Zig's own code
 * generator (which aligns vectors by the CPU's features), all of them; elsewhere the default.
 */
const cpusFor = (target: (typeof ZIG_TARGETS)[number]): (string | undefined)[] =>
  target.id === "x86_64-linux-gnu" ? [undefined, ...ZIG_X86_64_CPUS.filter((c) => c.id !== "x86_64").map((c) => c.id)] : [undefined];

const prepared: Prepared[] = [];
for (const target of ZIG_TARGETS) {
  for (const mode of MODES) {
    for (const cpu of cpusFor(target)) {
      for (const [label, code] of Object.entries(CASES)) {
        const analysis = analyzeZig(code, target.id, mode, cpu);
        prepared.push({ index: prepared.length, label, code, target, mode, cpu, analysis, expected: analysis.result ? facts(analysis) : "" });
      }
    }
  }
}

/** zig's answer for each compiled case: its facts, or why it rejected the case. */
const observed = new Map<number, Answer<string>>();
/** Groups whose compilation failed for a reason no case can be blamed for. */
const groupErrors = new Map<number, string>();
const dir = mkdtempSync(join(tmpdir(), "sp-zig-"));
const refs = new References<string>("zig");
afterAll(() => refs.save());
/** Without zig, the cases are checked against its recorded answers. */
const compileHere = zig && !useReferences;

async function compileAll() {
  const groups = new Map<string, Prepared[]>();
  for (const p of prepared) {
    if (!p.analysis.result) continue;
    const key = `${p.target.id} ${p.mode} ${p.cpu ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  // A few compilations at a time: each is a whole compiler.
  const queue = [...groups];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await compileGroup(...next);
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

/** Compile one file and return what the compiler reported (nothing when it compiled). */
async function compile(file: string, flags: string[]): Promise<string> {
  return run("zig", ["build-obj", ...flags, "-fno-emit-bin", file], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).then(
    () => "",
    (e: { stderr?: string }) => e.stderr ?? String(e),
  );
}

/** The case whose namespace holds a line of the generated file. */
function caseAtLine(lines: string[], line: number): number | undefined {
  const src = lines.slice(0, line).reverse().find((l) => /^const case_\d+ = struct/.test(l));
  return src ? Number(/case_(\d+)/.exec(src)![1]) : undefined;
}

/** A generated file is the cases one after another; the line numbers zig reports are its own. */
const numbered = (cases: string[][]) => cases.flatMap((c) => c.join("\n").split("\n"));

async function compileGroup(key: string, cases: Prepared[]) {
  const [targetId, mode, cpu] = key.split(" ");
  const target = ZIG_TARGETS.find((t) => t.id === targetId)!;
  const lines = numbered(cases.map((p) => [`const case_${p.index} = struct {`, p.code, "};", ...check(p)]));
  const file = join(dir, `${targetId}_${mode}${cpu ? `_${cpu}` : ""}.zig`);
  writeFileSync(file, lines.join("\n"));
  const output = await compile(file, [...zigTargetFlags(target, cpu || undefined), "-O", mode!]);
  // A case zig says nothing about has the facts it was checked for.
  for (const p of cases) observed.set(p.index, { layout: p.expected });
  let blamed = false;
  for (const m of output.matchAll(/^(.*?):(\d+):\d+: error: (.*)$/gm)) {
    const own = /^case (\d+): (.*)$/.exec(m[3]!);
    const index = own ? Number(own[1]) : caseAtLine(lines, Number(m[2]));
    if (index === undefined) continue;
    blamed = true;
    // A mismatch prints zig's facts in full; any other error is zig refusing the case.
    if (own) observed.set(index, { layout: own[2]! });
    else if (!("rejected" in observed.get(index)!)) observed.set(index, { rejected: m[3]! });
  }
  // An error no case can be blamed for fails them all, and is no answer to record.
  if (output && !blamed) for (const p of cases) groupErrors.set(p.index, output.slice(0, 3000));
}

/** What Zig refuses to compile: the engine must refuse it too. */
const REJECTED: Record<string, string> = {
  "pointer in a packed struct": "const P = packed struct { p: *u8, b: u8 };",
  "slice in an extern struct": "const S = extern struct { s: []u8 };",
  "inferred enum in an extern struct": "const E = enum { a, b };\nconst S = extern struct { e: E };",
  "odd integer in an extern struct": "const S = extern struct { a: u7 };",
  "function pointer without callconv in an extern struct": "const S = extern struct { f: *const fn () void };",
  "auto struct in an extern struct": "const A = struct { a: u8 };\nconst S = extern struct { a: A };",
  "backing integer of the wrong width": "const P = packed struct(u8) { a: u4 };",
  "packed union of unequal fields": "const U = packed union { a: u8, b: u16 };",
  "inferred enum in a packed struct": "const E = enum { a, b };\nconst P = packed struct { e: E };",
  "opaque field": "const O = opaque {};\nconst S = struct { o: O };",
  "struct holding itself": "const S = struct { a: u8, s: S };",
  "enum value out of range": "const E = enum(u8) { a = 256 };",
  "duplicate enum value": "const E = enum(u8) { a = 1, b = 1 };",
  "non-exhaustive enum without a tag type": "const E = enum { a, _ };",
  "union fields not matching the tag": "const Tag = enum { a, b };\nconst U = union(Tag) { a: u8, c: u16 };",
  "undeclared type": "const S = struct { a: Missing };",
};

it.runIf(requireZig)("zig 0.16 is installed", () => {
  expect(zig).toBe(true);
});

describe(`Zig rejects what the engine rejects${compileHere ? "" : " (recorded answers)"}`, () => {
  const cases = Object.entries(REJECTED).map(([label, code], i) => ({ label, code, i, a: analyzeZig(code, "x86_64-linux-gnu", "Debug") }));
  const rejected = new Map<number, string>();

  beforeAll(async () => {
    if (!compileHere) return;
    const lines = numbered(
      cases.map((c) => {
        const root = [...c.code.matchAll(/const (\w+) =/g)].pop()![1];
        return [`const case_${c.i} = struct {`, c.code, "};", `comptime { _ = @sizeOf(case_${c.i}.${root}); }`];
      }),
    );
    const file = join(dir, "rejected.zig");
    writeFileSync(file, lines.join("\n"));
    const output = await compile(file, ["-target", "x86_64-linux-gnu", "-O", "Debug"]);
    for (const m of output.matchAll(/^(.*?):(\d+):\d+: error: (.*)$/gm)) {
      const index = caseAtLine(lines, Number(m[2]));
      if (index !== undefined && !rejected.has(index)) rejected.set(index, m[3]!);
    }
  }, 600_000);

  for (const c of cases) {
    it(c.label, () => {
      const now = compileHere ? (rejected.has(c.i) ? { rejected: rejected.get(c.i)! } : { layout: "compiled" }) : undefined;
      const truth = refs.answer(`rejected | ${c.label}`, now);
      expect("rejected" in truth, "zig compiled it").toBe(true);
      expect(c.a.errors.length, `zig: ${"rejected" in truth ? truth.rejected : ""}`).toBeGreaterThan(0);
    });
  }
});

describe(`Zig layout matches zig 0.16${compileHere ? "" : " (recorded answers)"}`, () => {
  beforeAll(async () => {
    if (compileHere) await compileAll();
  }, 1_800_000);

  for (const p of prepared) {
    it(`${p.target.label} ${p.mode}${p.cpu ? ` ${p.cpu}` : ""}: ${p.label}`, () => {
      expect(p.analysis.errors, p.code).toEqual([]);
      const error = groupErrors.get(p.index);
      if (error) throw new Error(error);
      const truth = refs.answer(`${p.target.id} ${p.mode}${p.cpu ? ` ${p.cpu}` : ""} | ${p.label}`, compileHere ? observed.get(p.index) : undefined);
      if ("rejected" in truth) throw new Error(`zig rejects it: ${truth.rejected}`);
      if (!("layout" in truth)) throw new Error("zig gave no layout");
      expect(p.expected, "the engine's facts, then zig's").toBe(truth.layout);
    });
  }
});

/** The host's target, for running the verification programs. */
const host = process.arch === "x64" ? (process.platform === "win32" ? "x86_64-windows-gnu" : process.platform === "linux" ? "x86_64-linux-gnu" : process.platform === "darwin" ? "x86_64-macos-none" : undefined) : process.arch === "arm64" ? (process.platform === "linux" ? "aarch64-linux-gnu" : process.platform === "darwin" ? "aarch64-macos-none" : undefined) : undefined;

describe.skipIf(!compileHere || !host)("generated Zig verification programs", () => {
  for (const mode of ["Debug", "ReleaseFast"] as const) {
    const cases = Object.entries(CASES)
      .map(([label, code], i) => ({ label, code, i, a: analyzeZig(code, host!, mode) }))
      .filter((c) => c.a.result);
    const outputs = new Map<number, string>();

    beforeAll(async () => {
      const source = [
        ...cases.map((c) => generateZigVerificationModule(c.code, c.a, `case_${c.i}`)),
        "pub fn main() void {",
        ...cases.flatMap((c) => [`    @import("std").debug.print("=== ${c.i}\\n", .{});`, `    case_${c.i}.report();`]),
        "}",
      ].join("\n");
      const file = join(dir, `verify_${mode}.zig`);
      writeFileSync(file, source);
      const { stderr } = await run("zig", ["run", "-target", host!, "-O", mode, file], { cwd: dir, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
      for (const block of stderr.split("=== ").slice(1)) {
        const nl = block.indexOf("\n");
        outputs.set(Number(block.slice(0, nl)), block.slice(nl + 1));
      }
    }, 900_000);

    for (const c of cases) {
      it(`${mode}: ${c.label}`, () => {
        const out = outputs.get(c.i) ?? "";
        const r = c.a.result!;
        expect(out).toContain(`type ${c.a.definition!.name}: size ${r.totalSize}, align ${r.struct.alignment}\n`);
        expect(out).toContain(`  ?${c.a.definition!.name}: size ${c.a.optionalSize}\n`);
        for (const o of c.a.offsets) {
          const re = o.bitOffset !== undefined ? new RegExp(`^  ${o.name}\\s+bit offset:\\s+${o.bitOffset}\\s`, "m") : new RegExp(`^  ${o.name}\\s+offset:\\s+${o.offset}\\s`, "m");
          expect(out, out).toMatch(re);
        }
      });
    }
  }
});
