import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeStruct, examples } from "@sp/core";
import type { PlatformSelection } from "@sp/core";

/**
 * Ground truth on every target: each case (the bit-field, enum and pointer cases below, and every C
 * example) is compiled for every target whose compiler is installed, and the size, alignment,
 * offsetof of each plain member and the first bit and width of each bit-field are read back from
 * the object file. Nothing is run, so cross compilers work.
 *
 * Each case is its own translation unit, compiled in one shell call per target. It contributes a
 * byte array of its sizes and offsets, and one constant per bit-field with
 * only that field set to all ones: the bits that come out set are the field's. Bits are numbered
 * from the least significant bit of each byte; every target here is little-endian.
 *
 * The compilers are looked up on the PATH, or inside WSL when the tests run on Windows. A target
 * whose compiler is missing is skipped, or fails when SP_REQUIRE_COMPILERS is set (as in CI). On
 * Ubuntu:
 *   apt install --no-install-recommends gcc-i686-linux-gnu gcc-arm-linux-gnueabihf \
 *     gcc-aarch64-linux-gnu gcc-riscv64-linux-gnu gcc-mipsel-linux-gnu gcc-mingw-w64-x86-64-win32 \
 *     gcc-mingw-w64-i686-win32 gcc-arm-none-eabi gcc-riscv64-unknown-elf gcc-avr avr-libc sdcc
 */
const requireCompilers = Boolean(process.env.SP_REQUIRE_COMPILERS);

const run = promisify(execFile);

const viaWsl =
  process.platform === "win32" &&
  (() => {
    try {
      execFileSync("wsl.exe", ["-e", "true"], { stdio: "ignore", timeout: 60_000 });
      return true;
    } catch {
      return false;
    }
  })();

const toWsl = (p: string) => p.replace(/^([A-Za-z]):[\\/]/, (_, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");

function hasTool(cmd: string): boolean {
  if (process.platform === "win32" && !viaWsl) return false;
  try {
    const argv = ["-c", `command -v ${cmd}`];
    if (viaWsl) execFileSync("wsl.exe", ["-e", "sh", ...argv], { stdio: "ignore" });
    else execFileSync("sh", argv, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function tool(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = viaWsl
    ? await run("wsl.exe", ["--cd", toWsl(cwd), "-e", cmd, ...args], { maxBuffer: 64 * 1024 * 1024 })
    : await run(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

interface Target {
  name: string;
  selection: PlatformSelection;
  cc: string;
  flags: string[];
}

const TARGETS: Target[] = [
  { name: "x86-64 Linux (gcc)", selection: { target: "intel-x64-amd", dataModel: "LP64", os: "linux" }, cc: "gcc", flags: [] },
  { name: "i386 Linux (gcc)", selection: { target: "intel-x86", dataModel: "ILP32", os: "linux" }, cc: "i686-linux-gnu-gcc", flags: [] },
  { name: "x86-64 Windows (MinGW)", selection: { target: "intel-x64-amd", dataModel: "LLP64", os: "windows" }, cc: "x86_64-w64-mingw32-gcc", flags: [] },
  { name: "i386 Windows (MinGW)", selection: { target: "intel-x86", dataModel: "ILP32", os: "windows" }, cc: "i686-w64-mingw32-gcc", flags: [] },
  { name: "ARM32 Linux (gcc)", selection: { target: "arm32", dataModel: "ILP32", os: "linux" }, cc: "arm-linux-gnueabihf-gcc", flags: [] },
  { name: "ARM32 bare metal (arm-none-eabi)", selection: { target: "arm32", dataModel: "ILP32", os: "none" }, cc: "arm-none-eabi-gcc", flags: ["-mcpu=cortex-m4", "-mthumb"] },
  { name: "ARM64 Linux (gcc)", selection: { target: "arm64", dataModel: "LP64", os: "linux" }, cc: "aarch64-linux-gnu-gcc", flags: [] },
  { name: "RISC-V 32 Linux (gcc)", selection: { target: "riscv32", dataModel: "ILP32", os: "linux" }, cc: "riscv64-linux-gnu-gcc", flags: ["-march=rv32gc", "-mabi=ilp32d"] },
  { name: "RISC-V 32 bare metal (gcc)", selection: { target: "riscv32", dataModel: "ILP32", os: "none" }, cc: "riscv64-unknown-elf-gcc", flags: ["-march=rv32imac", "-mabi=ilp32"] },
  { name: "RISC-V 64 Linux (gcc)", selection: { target: "riscv64", dataModel: "LP64", os: "linux" }, cc: "riscv64-linux-gnu-gcc", flags: [] },
  { name: "RISC-V 64 bare metal (gcc)", selection: { target: "riscv64", dataModel: "LP64", os: "none" }, cc: "riscv64-unknown-elf-gcc", flags: ["-march=rv64imac", "-mabi=lp64"] },
  { name: "AVR, XC8 model (avr-gcc)", selection: { target: "microchip-8bit", dataModel: "XC8", os: "none" }, cc: "avr-gcc", flags: ["-mmcu=atmega328p"] },
  { name: "PIC32 MIPS, XC32 model (mipsel gcc)", selection: { target: "microchip-32bit", dataModel: "XC32", os: "none" }, cc: "mipsel-linux-gnu-gcc", flags: ["-mno-abicalls", "-fno-pic"] },
  { name: "8051 (SDCC)", selection: { target: "8051-8bit", dataModel: "SDCC", os: "none" }, cc: "sdcc", flags: ["-mmcs51", "--std-c11"] },
];

/** Cases name their types S, T and E; each gets a unique suffix in the generated file. */
const CASES: Record<string, string> = {
  // The data model each target's bit-fields are built on. Each member follows a char, so its
  // offset is its alignment rounded up from 1; sizes come from the differences.
  "scalar types":
    "struct S { char c0; short s; char c1; int i; char c2; long l; char c3; long long ll; char c4; float f; char c5; double d; char c6; void *p; char c7; _Bool b; };",
  "fields share a unit": "struct S { unsigned a:3, b:5, c:1, d:7; unsigned short e; char f; };",
  "char then int field": "struct S { char a; int b:4; char c; };",
  "field crossing its unit": "struct S { char a; int b:30; };",
  "different types share bits": "struct S { char a:3; int b:4; short c:9; char d; };",
  "short crossing": "struct S { char a; short b:9; char c; };",
  "char fields": "struct S { char a:7; char b:2; char c; };",
  "wide types after char": "struct S { char a:4; short b:12; char c:4; };",
  "long long field": "struct S { char a; long long b:40; char c; };",
  "int then long long field": "struct S { int a:20; long long b:40; };",
  "int and long": "struct S { int a:3; long b:4; char c; };",
  "int and unsigned": "struct S { int a:3; unsigned b:4; char c; };",
  "bool and char": "struct S { _Bool a:1; char b:3; char c; };",
  "bool fields then int": "struct S { _Bool a:1; _Bool b:1; char c; int d:2; };",
  "enum field": "enum E { E_A, E_B }; struct S { char a; enum E e:2; char c; };",
  "enum and int": "enum E { E_C }; struct S { enum E a:2; int b:3; char c; };",
  "zero-width after plain": "struct S { char a; int :0; char b; };",
  "zero-width between fields": "struct S { char a:3; int :0; char b:2; };",
  "zero-width char": "struct S { int a:3; char :0; char b; };",
  "zero-width same type": "struct S { char a:3; char :0; char b:2; };",
  "zero-width char then int": "struct S { char a:3; char :0; int b:4; };",
  "zero-width after int": "struct S { int a; int :0; char b:2; };",
  "zero-width first": "struct S { int :0; char a; };",
  "zero-width long long": "struct S { char a:1; long long :0; char b; };",
  "unnamed field": "struct S { char a; int :4; char b; };",
  "unnamed field last": "struct S { char a; int :4; };",
  "only char fields": "struct S { unsigned char a:3; unsigned char b:6; };",
  "only one field": "struct S { unsigned a:3; };",
  "short field last": "struct S { int a; short b:3; };",
  "int after field": "struct S { unsigned a:1; int b; };",
  "double after field": "struct S { unsigned a:9; double d; };",
  "struct after field": "struct T { char x; }; struct S { unsigned a:12; struct T t; char c; };",
  "packed struct": "struct __attribute__((packed)) S { char a:7; int b:30; char c; };",
  "packed struct, char then field": "struct __attribute__((packed)) S { char a; int b:4; char c; };",
  "packed struct, zero-width": "struct __attribute__((packed)) S { char a:3; int :0; char b; };",
  "packed struct, long long": "struct __attribute__((packed)) S { char a; long long b:60; };",
  "packed field": "struct S { char a:7; int b:30 __attribute__((packed)); char c; };",
  "pragma pack 1": "#pragma pack(push, 1)\nstruct S { char a:7; int b:30; char c; };\n#pragma pack(pop)",
  "pragma pack 1, zero-width": "#pragma pack(push, 1)\nstruct S { char a:3; int :0; char b; };\n#pragma pack(pop)",
  "pragma pack 2": "#pragma pack(push, 2)\nstruct S { char a:7; int b:30; char c; };\n#pragma pack(pop)",
  "pragma pack 2, two fields": "#pragma pack(push, 2)\nstruct S { char a; int b:20; int c:20; char d; };\n#pragma pack(pop)",
  "pragma pack 4": "#pragma pack(push, 4)\nstruct S { char a:7; int b:30; char c; };\n#pragma pack(pop)",
  "pragma pack 4, long long": "#pragma pack(push, 4)\nstruct S { char a; long long b:40; char c; };\n#pragma pack(pop)",
  "pragma pack 8": "#pragma pack(push, 8)\nstruct S { char a; int b:30; };\n#pragma pack(pop)",
  "aligned field": "struct S { char a; int b:4 __attribute__((aligned(8))); char c; };",
  // The same with long, which is at least 32 bits everywhere, for the 16-bit-int targets.
  "packed struct, long field": "struct __attribute__((packed)) S { char a:7; long b:30; char c; };",
  "pragma pack 1, long field": "#pragma pack(push, 1)\nstruct S { char a:7; long b:30; char c; };\n#pragma pack(pop)",
  "pragma pack 2, long field": "#pragma pack(push, 2)\nstruct S { char a:7; long b:30; char c; };\n#pragma pack(pop)",
  "long field crossing": "struct S { char a; long b:30; };",
  "union of small fields": "union S { char a; int b:12; long c:3; };",
  "fields crossing bytes": "struct S { unsigned a:6; unsigned b:4; unsigned c:6; };",
  "field after 12 bits": "struct S { unsigned a:12; unsigned b:6; };",
  "field over two bytes": "struct S { unsigned a:3; unsigned b:13; char c; };",
  "char fields overflowing": "struct S { unsigned char a:5; unsigned char b:5; };",
  "packed struct, zero-width after plain": "struct __attribute__((packed)) S { char a; int :0; char b; };",
  "packed zero-width field": "struct S { char a:3; int :0 __attribute__((packed)); char b; };",
  "pragma pack 2 and packed, zero-width": "#pragma pack(push, 2)\nstruct __attribute__((packed)) S { char a:3; int :0; char b; };\n#pragma pack(pop)",
  "pragma pack 2, zero-width": "#pragma pack(push, 2)\nstruct S { char a:3; int :0; char b; };\n#pragma pack(pop)",
  "union of fields": "union S { char a; int b:20; long long c:3; };",
  "union with unnamed field": "union S { char a; int :4; };",
  // Enum sizes where the values need more than a byte, or are negative.
  "enum above 255": "enum E { E_LO, E_HI = 300 }; struct S { char a; enum E e; char c; };",
  "enum above 65535": "enum E { E_HUGE = 70000 }; struct S { char a; enum E e; char c; };",
  "negative enum": "enum E { E_NEG = -1, E_POS = 1 }; struct S { char a; enum E e; char c; };",
  "negative enum below -128": "enum E { E_NEG = -200 }; struct S { char a; enum E e; char c; };",
  // Function pointers, which some targets size apart from data pointers.
  "function pointers": "struct S { char a; void (*f)(void); char b; void (**pf)(void); char c; int *p; char d; };",
  "typedef'd function pointers": "typedef void (*cb_t)(int); struct S { char a; cb_t cbs[2]; char b; cb_t *pcb; char c; };",
  // Every C example: nested structs, unions, arrays, pointers and enums on every target.
  ...Object.fromEntries(examples.map((e) => [`example: ${e.name}`, e.code.c])),
};

/** Named top-level members of the case's last definition: [name, is a bit-field]. */
function membersOf(code: string): { kind: "struct" | "union"; tag: string; members: [string, boolean][] } {
  const def = analyzeStruct(code, TARGETS[0]!.selection).definition!;
  return {
    kind: def.isUnion ? "union" : "struct",
    tag: def.name,
    members: def.members.filter((m) => m.name).map((m) => [m.name, m.bitField !== undefined]),
  };
}

/**
 * The translation unit for case i. Each case is compiled on its own, since the examples reuse
 * type names; its symbols carry the case's index.
 */
function probeSource(i: number): string {
  const code = entries[i]![1];
  const { kind, tag, members } = membersOf(code);
  const t = `${kind} ${tag}`;
  const values = [`sizeof(${t})`, `_Alignof(${t})`, ...members.filter(([, bf]) => !bf).map(([m]) => `offsetof(${t}, ${m})`)];
  const out = [
    "#include <stddef.h>",
    "#include <stdint.h>",
    "#define LO(v) ((unsigned char)((v) & 0xff))",
    "#define HI(v) ((unsigned char)(((v) >> 8) & 0xff))",
    code,
    `const unsigned char sv_${i}[] = { 0xA5, ${values.map((v) => `LO(${v}), HI(${v})`).join(", ")} };`,
    ...members.filter(([, bf]) => bf).map(([m]) => `const ${t} bi_${i}_${m} = { .${m} = -1 };`),
  ];
  return `${out.join("\n")}\n`;
}

/** Bytes of each data symbol: from objdump -s (one section per symbol), or SDCC's .db lines. */
function readSymbols(text: string, sdcc: boolean): Map<string, number[]> {
  const symbols = new Map<string, number[]>();
  let current: number[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (sdcc) {
      const label = /^_(\w+):/.exec(line);
      const data = /^\s+\.(db|byte|dw|ds)\s+([^;]*)/.exec(line);
      if (label) symbols.set(label[1]!, (current = []));
      else if (current && data) {
        const values = data[2]!.split(",").map((v) => parseInt(v.trim().replace(/^#/, ""), 16));
        if (data[1] === "ds") current.push(...new Array<number>(parseInt(data[2]!, 10)).fill(0));
        else if (data[1] === "dw") for (const v of values) current.push(v & 0xff, (v >> 8) & 0xff);
        else current.push(...values);
      } else if (current && /^\s*\.(area|globl)|^\s*\S+:/.test(line)) current = null;
      continue;
    }
    const section = /^Contents of section (\S+):$/.exec(line);
    if (section) {
      const name = section[1]!.split(/[.$]/).pop()!;
      symbols.set(name, (current = []));
      continue;
    }
    const row = /^ [0-9a-f]+ (.{35})/.exec(line);
    if (current && row) {
      const hex = row[1]!.replace(/[^0-9a-f]/g, "");
      for (let i = 0; i + 1 < hex.length; i += 2) current.push(parseInt(hex.slice(i, i + 2), 16));
    }
  }
  return symbols;
}

/** The object file does not show the layout, e.g. SDCC truncating an initializer after `int :0`. */
class Unmeasurable extends Error {}

interface Measured {
  size: number;
  align: number;
  offsets: Record<string, number>;
  bits: Record<string, [number, number]>;
}

function measured(symbols: Map<string, number[]>, code: string, i: number): Measured {
  const { members } = membersOf(code);
  const sv = symbols.get(`sv_${i}`);
  if (!sv || sv[0] !== 0xa5) throw new Error(`sv_${i} not found in the object file`);
  const word = (k: number) => sv[1 + 2 * k]! | (sv[2 + 2 * k]! << 8);
  const plain = members.filter(([, bf]) => !bf).map(([m]) => m);
  const bits: Measured["bits"] = {};
  for (const [m, bf] of members) {
    if (!bf) continue;
    const section = symbols.get(`bi_${i}_${m}`);
    if (!section) throw new Error(`bi_${i}_${m} not found in the object file`);
    // A section may be padded out to its alignment; one shorter than the type was truncated.
    if (section.length < word(0)) {
      throw new Unmeasurable(`the compiler emitted ${section.length} bytes for '${m}'s ${word(0)}-byte initializer`);
    }
    const image = section.slice(0, word(0));
    let first = -1;
    let width = 0;
    image.forEach((byte, b) => {
      for (let k = 0; k < 8; k += 1) {
        if ((byte >> k) & 1) {
          if (first < 0) first = b * 8 + k;
          width += 1;
        }
      }
    });
    bits[m] = [first, width];
  }
  return {
    size: word(0),
    align: word(1),
    offsets: Object.fromEntries(plain.map((m, k) => [m, word(2 + k)])),
    bits,
  };
}

function modelled(code: string, i: number, selection: PlatformSelection): Measured {
  const analysis = analyzeStruct(code, selection);
  expect(analysis.errors.map((e) => e.message)).toEqual([]);
  const result = analysis.result!;
  const offsets: Measured["offsets"] = {};
  const bits: Measured["bits"] = {};
  for (const m of result.members) {
    if (!m.member.name) continue;
    if (m.member.bitField === undefined) offsets[m.member.name] = m.offset;
    else bits[m.member.name] = [m.bitOffset ?? -1, m.member.bitField];
  }
  return { size: result.totalSize, align: result.struct.alignment ?? 0, offsets, bits };
}

const entries = Object.entries(CASES);
// A case the engine cannot parse fails in its test rather than being sent to the compilers.
const parsable = entries.flatMap(([, code], i) =>
  analyzeStruct(code, TARGETS[0]!.selection).errors.length === 0 ? [i] : [],
);

for (const target of TARGETS) {
  if (!hasTool(target.cc)) {
    if (requireCompilers) {
      it(`${target.cc} is installed for ${target.name}`, () => {
        throw new Error(`${target.cc} not found, and SP_REQUIRE_COMPILERS is set`);
      });
    } else {
      describe.skip(`layouts match ${target.name} (${target.cc} not installed)`, () => {
        it.skip("not run", () => {});
      });
    }
    continue;
  }
  describe(`layouts match ${target.name}`, () => {
    const sdcc = target.cc === "sdcc";
    /** Symbols per case index, or the compiler's error for a case it rejects. */
    const results = new Map<number, Map<string, number[]> | string>();

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), "sp-cc-"));
      for (const i of parsable) writeFileSync(join(dir, `case_${i}.c`), probeSource(i));
      const quote = (args: string[]) => args.map((a) => `'${a}'`).join(" ");
      // Freestanding: GCC's own <stddef.h> and <stdint.h>, so no target C library is needed.
      const common = ["-std=gnu11", "-ffreestanding", "-w", "-O0", "-c", "-fdata-sections", "-fno-common"];
      const objdump = target.cc.replace(/gcc$/, "objdump");
      const each = sdcc
        ? `if sdcc ${quote(target.flags)} -c "$f" -o "$b.rel" > "$b.err" 2>&1; then :; else rm -f "$b.asm"; fi`
        : `if ${target.cc} ${quote([...target.flags, ...common])} -o "$b.o" "$f" 2> "$b.err"; then ${objdump} -s "$b.o" > "$b.dump"; fi`;
      await tool("sh", ["-c", `for f in case_*.c; do b="\${f%.c}"; ${each}; done`], dir);

      for (const i of parsable) {
        const output = join(dir, `case_${i}.${sdcc ? "asm" : "dump"}`);
        results.set(
          i,
          existsSync(output)
            ? readSymbols(readFileSync(output, "utf8"), sdcc)
            : readFileSync(join(dir, `case_${i}.err`), "utf8").trim(),
        );
      }
    }, 600_000);

    entries.forEach(([label, code], i) => {
      it(label, (ctx) => {
        const symbols = results.get(i);
        if (symbols === undefined) {
          // Not parsable by the engine: report the parser's errors.
          expect(analyzeStruct(code, target.selection).errors.map((e) => e.message)).toEqual([]);
          return;
        }
        if (typeof symbols === "string") {
          // The compiler does not accept this declaration, so it has no layout to compare.
          const reason = symbols.split("\n").find((l) => /error/i.test(l)) ?? symbols;
          if (process.env.SP_CROSS_VERBOSE) console.log(`[skip] ${target.name} | ${label} | ${reason}`);
          ctx.skip(`${target.cc} rejects it: ${reason}`);
          return;
        }
        const actual = modelled(code, i, target.selection);
        let expected: Measured;
        try {
          expected = measured(symbols, code, i);
        } catch (err) {
          if (!(err instanceof Unmeasurable)) throw err;
          if (process.env.SP_CROSS_VERBOSE) console.log(`[skip] ${target.name} | ${label} | ${err.message}`);
          ctx.skip(err.message);
          return;
        }
        if (process.env.SP_CROSS_VERBOSE && JSON.stringify(actual) !== JSON.stringify(expected)) {
          console.log(`[diff] ${target.name} | ${label}\n  engine:   ${JSON.stringify(actual)}\n  compiler: ${JSON.stringify(expected)}`);
        }
        expect(actual).toEqual(expected);
      });
    });
  });
}
