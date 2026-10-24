import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeStruct, examples } from "@sp/core";
import type { CalculationResult, PlatformSelection, SourceLanguage } from "@sp/core";
import { hasTool, msvc, readCoffSymbols, tool, vcvarsall } from "./support/compilers";
import { References, useReferences } from "./support/references";
import type { Answer } from "./support/references";

/**
 * C++ class layout against the compilers: each case is compiled as C++17 and as C++20 by g++ for
 * the Itanium C++ ABI targets and by MSVC for Windows, and the layout of its class S is read back
 * from what the compiler reports about it:
 * - g++'s -fdump-lang-class: size, alignment, size and alignment as a base, and the offset of
 *   every base class subobject; the offsets of S's own members come from offsetof in the object.
 * - MSVC's /d1reportAllClassLayout: the offset of every base, vfptr, vbptr, vtordisp and member,
 *   and of each virtual base (its vbi table); size and alignment come from the object file.
 *
 * The g++ cross compilers are found as in tests/cross-compiler.test.ts; a target whose compiler
 * is missing is checked against its recorded answers (tests/references/cpp.json). On Ubuntu:
 *   apt install --no-install-recommends g++ g++-i686-linux-gnu g++-arm-linux-gnueabihf \
 *     g++-aarch64-linux-gnu g++-riscv64-linux-gnu g++-mipsel-linux-gnu g++-powerpc-linux-gnu g++-mips-linux-gnu g++-arm-none-eabi \
 *     gcc-avr avr-libc
 */
const requireCompilers = Boolean(process.env.SP_REQUIRE_COMPILERS);
const requireMsvc = Boolean(process.env.SP_REQUIRE_MSVC);

interface Target {
  name: string;
  selection: PlatformSelection;
  cc: string;
  flags: string[];
  msvc?: "x64" | "x86";
  /** avr-g++ 7 names the class dump -fdump-class-hierarchy and does not take -std=c++20. */
  oldGcc?: boolean;
}

const TARGETS: Target[] = [
  { name: "x86-64 Linux (g++)", selection: { target: "intel-x64-amd", dataModel: "LP64", os: "linux" }, cc: "g++", flags: [] },
  { name: "i386 Linux (g++)", selection: { target: "intel-x86", dataModel: "ILP32", os: "linux" }, cc: "i686-linux-gnu-g++", flags: [] },
  { name: "ARM32 Linux (g++)", selection: { target: "arm32", dataModel: "ILP32", os: "linux" }, cc: "arm-linux-gnueabihf-g++", flags: [] },
  { name: "ARM32 bare metal (arm-none-eabi-g++)", selection: { target: "arm32", dataModel: "ILP32", os: "none" }, cc: "arm-none-eabi-g++", flags: ["-mcpu=cortex-m4", "-mthumb"] },
  { name: "ARM64 Linux (g++)", selection: { target: "arm64", dataModel: "LP64", os: "linux" }, cc: "aarch64-linux-gnu-g++", flags: [] },
  { name: "RISC-V 32 Linux (g++)", selection: { target: "riscv32", dataModel: "ILP32", os: "linux" }, cc: "riscv64-linux-gnu-g++", flags: ["-march=rv32gc", "-mabi=ilp32d"] },
  { name: "RISC-V 64 Linux (g++)", selection: { target: "riscv64", dataModel: "LP64", os: "linux" }, cc: "riscv64-linux-gnu-g++", flags: [] },
  { name: "PIC32 MIPS, XC32 model (mipsel g++)", selection: { target: "microchip-32bit", dataModel: "XC32", os: "none" }, cc: "mipsel-linux-gnu-g++", flags: ["-mno-abicalls", "-fno-pic"] },
  { name: "PowerPC 32 Linux, big-endian (g++)", selection: { target: "powerpc32", dataModel: "ILP32", os: "linux" }, cc: "powerpc-linux-gnu-g++", flags: [] },
  { name: "MIPS32 Linux, big-endian (g++)", selection: { target: "mips32-be", dataModel: "ILP32", os: "linux" }, cc: "mips-linux-gnu-g++", flags: [] },
  { name: "AVR, XC8 model (avr-g++)", selection: { target: "microchip-8bit", dataModel: "XC8", os: "none" }, cc: "avr-g++", flags: ["-mmcu=atmega328p"], oldGcc: true },
  { name: "x86-64 Windows (MSVC)", selection: { target: "intel-x64-amd", dataModel: "LLP64", os: "windows" }, cc: "cl", flags: [], msvc: "x64" },
  { name: "i386 Windows (MSVC)", selection: { target: "intel-x86", dataModel: "ILP32", os: "windows" }, cc: "cl", flags: [], msvc: "x86" },
];

/** Each case's last class is S; it is what is compared. */
const CASES: Record<string, string> = {
  // Single and multiple inheritance, and when a derived class may use a base's tail padding.
  "POD base": "struct A { int a; char c; }; struct S : A { char d; };",
  "base with a constructor": "struct A { int a; char c; A(); }; struct S : A { char d; };",
  "base with a defaulted constructor": "struct A { int a; char c; A() = default; }; struct S : A { char d; };",
  "base with an explicit constructor": "struct A { int a; char c; explicit A() = default; }; struct S : A { char d; };",
  "base with a deleted constructor": "struct A { int a; char c; A() = delete; }; struct S : A { char d; };",
  "base with a template constructor": "struct A { int a; char c; template <class T> A(T); }; struct S : A { char d; };",
  "base with a private member": "struct A { int a; private: char c; }; struct S : A { char d; };",
  "class base, private by default": "class A { int a; char c; public: int f(); }; struct S : A { char d; };",
  "base with a protected member": "struct A { int a; protected: char c; }; struct S : A { char d; };",
  "base with a default member initializer": "struct A { int a; char c = 1; }; struct S : A { char d; };",
  "base with a destructor": "struct A { int a; char c; ~A(); }; struct S : A { char d; };",
  "base with a defaulted destructor": "struct A { int a; char c; ~A() = default; }; struct S : A { char d; };",
  "base with a copy assignment": "struct A { int a; char c; A& operator=(const A&); }; struct S : A { char d; };",
  "base with a move assignment": "struct A { int a; char c; A& operator=(A&&); }; struct S : A { char d; };",
  "base with a reference member": "struct A { int& r; char c; }; struct S : A { char d; };",
  "base with a non-POD member": "struct P { private: int x; }; struct A { P p; char c; }; struct S : A { char d; };",
  "base with a base": "struct G { int g; }; struct A : G { char c; }; struct S : A { char d; };",
  "base with methods and statics": "struct A { int a; char c; void f(); static int s; }; struct S : A { char d; };",
  "bit-field in a base's tail padding": "struct A { int a; char c; A(); }; struct S : A { int b : 4; };",
  "two bases": "struct A { int a; }; struct B { char b; }; struct S : A, B { short s; };",
  "two bases with tail padding": "struct A { int a; char c; A(); }; struct B { short b; char d; B(); }; struct S : A, B { char s; };",
  "class with private members": "class S { int a; char c; public: S(); int f() const; };",
  // Empty bases and members.
  "empty class": "struct S {};",
  "empty class with methods": "class S { public: void f(); static int n; };",
  "empty base": "struct E {}; struct S : E { int x; };",
  "two empty bases": "struct E1 {}; struct E2 {}; struct S : E1, E2 { int x; };",
  "only empty bases": "struct E1 {}; struct E2 {}; struct S : E1, E2 {};",
  "empty base after a non-empty one": "struct E {}; struct A { int a; }; struct S : A, E { int s; };",
  "empty base and member of its type": "struct E {}; struct S : E { E e; int x; };",
  "empty base and two members of its type": "struct E {}; struct S : E { E e1; E e2; char c; };",
  "empty base twice, through bases": "struct E {}; struct A : E { int a; }; struct S : E, A { char c; };",
  "repeated indirect empty base": "struct E {}; struct A : E {}; struct B : E {}; struct S : A, B { int x; };",
  "empty member": "struct E {}; struct S { E e; int x; };",
  "no_unique_address empty member": "struct E {}; struct S { [[no_unique_address]] E e; int x; };",
  "no_unique_address members of one type": "struct E {}; struct S { [[no_unique_address]] E a; [[no_unique_address]] E b; int x; };",
  "no_unique_address non-POD member": "struct A { int a; char c; A(); }; struct S { [[no_unique_address]] A a; char d; };",
  "msvc::no_unique_address empty member": "struct E {}; struct S { [[msvc::no_unique_address]] E e; int x; };",
  "msvc::no_unique_address members of one type": "struct E {}; struct S { [[msvc::no_unique_address]] E a; [[msvc::no_unique_address]] E b; int x; };",
  "msvc::no_unique_address after a member": "struct E {}; struct S { int x; [[msvc::no_unique_address]] E e; };",
  // Virtual functions.
  "virtual function": "struct S { virtual void f(); int x; };",
  "virtual function and double": "struct S { virtual void f(); double d; };",
  "virtual destructor": "struct S { virtual ~S(); char c; };",
  "pure virtual function": "struct S { virtual int f() const = 0; short s; };",
  "polymorphic base": "struct A { virtual void f(); int a; }; struct S : A { int b; };",
  "override without virtual": "struct A { virtual void f(int); char a; }; struct S : A { void f(int); char b; };",
  "polymorphic second base": "struct A { int a; }; struct B { virtual void f(); int b; }; struct S : A, B { int c; };",
  "two polymorphic bases": "struct A { virtual void f(); int a; }; struct B { virtual void g(); int b; }; struct S : A, B { int s; };",
  "virtual function added to a plain base": "struct A { int a; }; struct S : A { virtual void f(); char c; };",
  "virtual function, empty base": "struct E {}; struct S : E { virtual void f(); int x; };",
  // Virtual bases.
  "virtual base": "struct V { int v; }; struct S : virtual V { int s; };",
  "virtual base with a double": "struct V { double v; }; struct S : virtual V { char s; };",
  "empty virtual base": "struct E {}; struct S : virtual E { int s; };",
  "diamond": "struct V { int v; }; struct A : virtual V { int a; }; struct B : virtual V { int b; }; struct S : A, B { int s; };",
  "polymorphic virtual base": "struct V { virtual void f(); int v; }; struct S : virtual V { int s; };",
  "nearly empty virtual base": "struct V { virtual void f(); }; struct S : virtual V { int s; };",
  "virtual and non-virtual bases": "struct V { int v; }; struct A { int a; }; struct S : A, virtual V { int s; };",
  "virtual base of a virtual base": "struct V { int v; }; struct W : virtual V { int w; }; struct S : virtual W { int s; };",
  "two virtual bases through a base": "struct V1 { int a; }; struct V2 { int b; }; struct A : virtual V1 { char c; }; struct S : A, virtual V2 { int s; };",
  "override in a virtual base with a constructor": "struct V { virtual void f(); int v; }; struct S : virtual V { S(); void f() override; int s; };",
  "override in a virtual base without a constructor": "struct V { virtual void f(); int v; }; struct S : virtual V { void f() override; int s; };",
  "override in a virtual base with a destructor": "struct V { virtual void f(int); int v; }; struct S : virtual V { ~S(); void f(int); int s; };",
  "new virtual function, virtual base": "struct V { virtual void f(); int v; }; struct S : virtual V { virtual void g(); int s; };",
  "virtual base's base overridden": "struct B { virtual void f(); int b; }; struct V : B { int v; }; struct S : virtual V { S(); void f(); int s; };",
  // Packing and alignment requests on classes.
  "pragma pack 1 with a base": "#pragma pack(push, 1)\nstruct A { char c; int i; };\nstruct S : A { char d; double e; };\n#pragma pack(pop)",
  "pragma pack 2 with a vptr": "#pragma pack(push, 2)\nstruct S { virtual void f(); char c; double d; };\n#pragma pack(pop)",
  "pragma pack 1 with a virtual base": "#pragma pack(push, 1)\nstruct V { char c; int i; };\nstruct S : virtual V { char d; };\n#pragma pack(pop)",
  "aligned base": "struct alignas(16) A { int a; }; struct S : A { char c; };",
  "aligned member in a derived class": "struct A { int a; }; struct S : A { alignas(16) char c; };",
  "union with a constructor": "union S { int a; char b; S(); };",
  // MSVC's own spelling.
  "empty_bases": "struct E1 {}; struct E2 {}; struct __declspec(empty_bases) S : E1, E2 { int x; };",
  // Every example: the C++ ones, and the C ones as C++, where a class with no C++ features has its C layout.
  ...Object.fromEntries(examples.map((e) => [`example: ${e.name}`, e.code])),
};

const STANDARDS: Array<{ language: SourceLanguage; gcc: string; msvc: string }> = [
  { language: "c++17", gcc: "c++17", msvc: "c++17" },
  { language: "c++20", gcc: "c++20", msvc: "c++20" },
];

interface Entry {
  label: string;
  code: string;
  language: SourceLanguage;
}
const entries: Entry[] = Object.entries(CASES).flatMap(([label, code]) => STANDARDS.map((s) => ({ label: `${label} [${s.language}]`, code, language: s.language })));

/** What is compared: size, alignment, and where each subobject and member of S is. */
interface Measured {
  size: number;
  align: number;
  /** g++ only: S as a base (its nvsize and nvalign). */
  baseSize?: number;
  baseAlign?: number;
  /** Base class subobjects at every depth, by absolute offset: "A@0", "V@16 virtual". */
  subobjects: string[];
  /** MSVC only: its vfptrs, vbptrs and vtordisps by absolute offset. */
  pointers?: string[];
  /** S's own named members that are not bit-fields. */
  offsets: Record<string, number>;
}

/** The engine's layout of S, in the terms the compiler reports. */
function modelled(entry: Entry, target: Target): Measured {
  const analysis = analyzeStruct(entry.code, target.selection, { language: entry.language });
  expect(analysis.errors.map((e) => e.message)).toEqual([]);
  const result = analysis.result!;
  const subobjects: string[] = [];
  const pointers: string[] = [];
  const walk = (r: CalculationResult, base: number) => {
    for (const m of r.members) {
      const at = base + m.offset;
      const role = m.member.role;
      if (role === "base" || role === "virtual-base") {
        subobjects.push(`${m.member.name}@${at}${role === "virtual-base" ? " virtual" : ""}`);
        if (m.nested) walk(m.nested, at);
      } else if (role === "vptr" || role === "vbptr" || role === "vtordisp") {
        pointers.push(`${role === "vptr" ? "vfptr" : role}@${at}`);
      }
    }
  };
  walk(result, 0);
  const offsets = Object.fromEntries(result.members.filter((m) => !m.member.role && m.member.name && m.member.bitField === undefined).map((m) => [m.member.name, m.offset]));
  const measured: Measured = { size: result.totalSize, align: result.struct.alignment ?? 0, subobjects: subobjects.sort(), offsets };
  if (target.msvc) measured.pointers = pointers.sort();
  else {
    measured.baseSize = result.baseSize;
    measured.baseAlign = result.baseAlignment;
  }
  return measured;
}

/** The class laid out (the last definition) and its own named members that are not bit-fields. */
function classOf(entry: Entry): { name: string; members: string[] } {
  const def = analyzeStruct(entry.code, TARGETS[0]!.selection, { language: entry.language }).definition;
  return { name: def?.name ?? "S", members: (def?.members ?? []).filter((m) => m.name && m.bitField === undefined).map((m) => m.name) };
}

function probeSource(entry: Entry, i: number, target: Target): string {
  const { name, members } = classOf(entry);
  const values = [`sizeof(${name})`, `alignof(${name})`, ...(target.msvc ? [] : members.map((m) => `offsetof(${name}, ${m})`))];
  return [
    "#include <stddef.h>",
    "#include <stdint.h>",
    entry.code,
    "#define LO(v) (unsigned char)((v) & 0xff)",
    "#define HI(v) (unsigned char)(((v) >> 8) & 0xff)",
    `extern "C" const unsigned char v_${i}[] = { 0xA5, ${values.map((v) => `LO(${v}), HI(${v})`).join(", ")} };`,
    "",
  ].join("\n");
}

/** Keys in one order, so two printed measurements differ only where their values do. */
const sorted = (value: unknown): unknown =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]))
    : value;

const words = (bytes: number[]) => {
  if (bytes[0] !== 0xa5) throw new Error("value array not found in the object file");
  return Array.from({ length: (bytes.length - 1) >> 1 }, (_, k) => bytes[1 + 2 * k]! | (bytes[2 + 2 * k]! << 8));
};

/** Bytes of each data symbol in objdump -s output (one section per symbol with -fdata-sections). */
function objdumpSymbols(text: string): Map<string, number[]> {
  const symbols = new Map<string, number[]>();
  let current: number[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const section = /^Contents of section (\S+):$/.exec(line);
    if (section) {
      symbols.set(section[1]!.split(/[.$]/).pop()!, (current = []));
      continue;
    }
    const row = /^ [0-9a-f]+ (.{35})/.exec(line);
    if (current && row) {
      const hex = row[1]!.replace(/[^0-9a-f]/g, "");
      for (let k = 0; k + 1 < hex.length; k += 2) current.push(parseInt(hex.slice(k, k + 2), 16));
    }
  }
  return symbols;
}

/** The class in g++'s class dump: size and alignment, as a base, and its subobject tree with offsets. */
function gccClass(dump: string, name: string): Pick<Measured, "size" | "align" | "baseSize" | "baseAlign" | "subobjects"> {
  const lines = dump.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `Class ${name}`);
  if (start < 0) throw new Error(`class ${name} not in the dump`);
  const size = /size=(\d+) align=(\d+)/.exec(lines[start + 1]!)!;
  const base = /base size=(\d+) base align=(\d+)/.exec(lines[start + 2]!)!;
  const subobjects: string[] = [];
  for (let k = start + 4; k < lines.length && lines[k]!.trim() !== ""; k++) {
    // "A (0x...) 8", "V (0x...) 16 virtual", "E (0x...) 0 empty virtual", "V (0x...) 0 nearly-empty virtual".
    const m = /^\s*(\w+) \(0x[0-9a-fx]+\) (\d+)(.*)$/.exec(lines[k]!);
    if (m) subobjects.push(`${m[1]}@${m[2]}${/\bvirtual\b/.test(m[3]!) ? " virtual" : ""}`);
  }
  return { size: +size[1]!, align: +size[2]!, baseSize: +base[1]!, baseAlign: +base[2]!, subobjects: subobjects.sort() };
}

/** The class in MSVC's /d1reportAllClassLayout output. */
function msvcClass(report: string, name: string): Pick<Measured, "subobjects" | "pointers" | "offsets"> {
  const lines = report.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^class ${name}\\tsize\\(\\d+\\):$`).test(l));
  if (start < 0) throw new Error(`class ${name} not in the layout report`);
  const subobjects: string[] = [];
  const pointers: string[] = [];
  const offsets: Record<string, number> = {};
  let k = start + 1;
  /** In a virtual base's section, whose members are printed at the same depth as the class's own. */
  let inVirtualBase = false;
  for (; k < lines.length && lines[k]!.trim() !== ""; k++) {
    const line = lines[k]!;
    const at = /^\s*(\d+)\.?\t(.*)$/.exec(line);
    const body = at ? at[2]! : line.replace(/^\s*\t?/, "");
    const depth = (/^((?:\| )*)/.exec(body)?.[1]?.length ?? 0) / 2;
    const text = body.replace(/^(?:\| )*/, "");
    if (depth === 0 && /^\+--- \(virtual base \w+\)/.test(text)) inVirtualBase = true;
    const base = /^\+--- \(base class (\w+)\)/.exec(text);
    if (base && at) subobjects.push(`${base[1]}@${at[1]}`);
    else if (text === "{vfptr}" && at) pointers.push(`vfptr@${at[1]}`);
    else if (text === "{vbptr}" && at) pointers.push(`vbptr@${at[1]}`);
    else if (/^\(vtordisp for vbase \w+\)$/.test(text) && at) pointers.push(`vtordisp@${at[1]}`);
    else if (at && depth === 1 && !inVirtualBase && !text.startsWith("<alignment member>") && !text.startsWith("+") && !/bitstart=/.test(text)) {
      // "x", or "Type x" for a member of class type.
      const member = /(\w+)\s*$/.exec(text)?.[1];
      if (member) offsets[member] = +at[1]!;
    }
  }
  // Virtual bases: their offsets are in the vbi table that follows.
  const vbi = lines.findIndex((l, n) => n > k && /^vbi:/.test(l));
  const next = lines.findIndex((l, n) => n > k && /^class /.test(l));
  if (vbi >= 0 && (next < 0 || vbi < next)) {
    for (let n = vbi + 1; n < lines.length && /^\s+\w+\s+\d+/.test(lines[n]!); n++) {
      const m = /^\s+(\w+)\s+(\d+)/.exec(lines[n]!)!;
      subobjects.push(`${m[1]}@${m[2]} virtual`);
    }
  }
  return { subobjects: subobjects.sort(), pointers: pointers.sort(), offsets };
}

const refs = new References<Measured>("cpp");
afterAll(() => refs.save());

for (const target of TARGETS) {
  const installed = target.msvc ? vcvarsall !== null : hasTool(target.cc);
  if (!installed && (target.msvc ? requireMsvc : requireCompilers)) {
    it(`${target.cc} is installed for ${target.name}`, () => {
      throw new Error(`${target.cc} not found, and ${target.msvc ? "SP_REQUIRE_MSVC" : "SP_REQUIRE_COMPILERS"} is set`);
    });
    continue;
  }
  // Without the compiler, the layouts are checked against its recorded answers.
  const compile = installed && !useReferences;
  describe(`C++ layouts match ${target.name}${compile ? "" : " (recorded answers)"}`, () => {
    /** Per entry: what the compiler reports, or its error for a case it rejects. */
    const results = new Map<number, Measured | string>();
    const applies = (e: Entry) => !(target.oldGcc && e.language === "c++20");

    beforeAll(async () => {
      if (!compile) return;
      const dir = mkdtempSync(join(tmpdir(), "sp-cpp-"));
      for (const std of STANDARDS) {
        const cases = entries.flatMap((e, i) => (e.language === std.language && applies(e) ? [i] : []));
        for (const i of cases) writeFileSync(join(dir, `case_${i}.cpp`), probeSource(entries[i]!, i, target));
        if (target.msvc) {
          // One cl run for every case: cl names each file before its diagnostics and layouts.
          writeFileSync(join(dir, "cases.rsp"), cases.map((i) => `case_${i}.cpp`).join("\n"));
          const { output } = await msvc(target.msvc, ["/c", "/w", "/EHsc", `/std:${std.msvc}`, "/d1reportAllClassLayout", "@cases.rsp"], dir);
          const sections = new Map<number, string[]>();
          let current: string[] | undefined;
          for (const line of output.split(/\r?\n/)) {
            const file = /^case_(\d+)\.cpp$/.exec(line.trim());
            if (file) sections.set(+file[1]!, (current = []));
            else current?.push(line);
          }
          for (const i of cases) {
            const text = (sections.get(i) ?? []).join("\n");
            const errors = output.split(/\r?\n/).filter((l) => l.startsWith(`case_${i}.cpp(`) && /error/.test(l));
            const obj = join(dir, `case_${i}.obj`);
            if (errors.length > 0 || !existsSync(obj)) {
              results.set(i, errors.join("\n") || text.trim() || "no object file");
              continue;
            }
            const [size, align] = words(readCoffSymbols(readFileSync(obj)).get(`v_${i}`) ?? []);
            results.set(i, { size: size!, align: align!, ...msvcClass(text, classOf(entries[i]!).name) });
          }
          continue;
        }
        const quote = (args: string[]) => args.map((a) => `'${a}'`).join(" ");
        const dump = target.oldGcc ? "-fdump-class-hierarchy" : '-fdump-lang-class="$b.class"';
        const common = ["-w", "-O0", "-c", "-fdata-sections", "-ffreestanding", `-std=${std.gcc}`];
        const objdump = target.cc.replace(/g\+\+$/, "objdump");
        const each = `if ${target.cc} ${quote([...target.flags, ...common])} ${dump} -o "$b.o" "$f" 2> "$b.err"; then ${objdump} -s "$b.o" > "$b.dump"; fi`;
        const list = cases.map((i) => `case_${i}.cpp`).join(" ");
        await tool("sh", ["-c", `for f in ${list}; do b="\${f%.cpp}"; ${each}; done`], dir);
        for (const i of cases) {
          const objText = join(dir, `case_${i}.dump`);
          if (!existsSync(objText)) {
            results.set(i, readFileSync(join(dir, `case_${i}.err`), "utf8").trim());
            continue;
          }
          const classFile = target.oldGcc ? readdirSync(dir).find((f) => f.startsWith(`case_${i}.cpp.`) && f.endsWith(".class")) : `case_${i}.class`;
          const [size, align, ...offsets] = words(objdumpSymbols(readFileSync(objText, "utf8")).get(`v_${i}`) ?? []);
          const { name, members } = classOf(entries[i]!);
          const cls = gccClass(readFileSync(join(dir, classFile!), "utf8"), name);
          results.set(i, { ...cls, size: size!, align: align!, offsets: Object.fromEntries(members.map((n, k) => [n, offsets[k]!])) });
        }
      }
    }, 900_000);

    entries.forEach((entry, i) => {
      if (!applies(entry)) return;
      it(entry.label, (ctx) => {
        if (target.oldGcc && entry.code.includes("[[no_unique_address]]")) {
          // GCC added [[no_unique_address]] in version 9; avr-g++ 7 ignores it.
          ctx.skip(`${target.cc} predates [[no_unique_address]] (GCC 9) and ignores it`);
          return;
        }
        let now: Answer<Measured> | undefined;
        if (compile) {
          const reported = results.get(i)!;
          now = typeof reported === "string" ? { rejected: reported.split("\n").find((l) => /error/i.test(l)) ?? reported } : { layout: reported };
        }
        const truth = refs.answer(`${target.name} | ${entry.label}`, now);
        if ("rejected" in truth) {
          if (process.env.SP_CROSS_VERBOSE) console.log(`[skip] ${target.name} | ${entry.label} | ${truth.rejected}`);
          ctx.skip(`${target.cc} rejects it: ${truth.rejected}`);
          return;
        }
        if ("unmeasurable" in truth) {
          ctx.skip(truth.unmeasurable);
          return;
        }
        const expected = truth.layout;
        const actual = modelled(entry, target);
        if (process.env.SP_CROSS_VERBOSE && JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) {
          console.log(`[diff] ${target.name} | ${entry.label}\n  engine:   ${JSON.stringify(sorted(actual))}\n  compiler: ${JSON.stringify(sorted(expected))}`);
        }
        expect(actual).toEqual(expected);
      });
    });
  });
}
