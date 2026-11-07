/**
 * Zig targets and the scalar layout rules Zig 0.17 applies to them, ported from the compiler:
 * `std.zig.target.intAlignment`/`intByteSize` for integers, `std.Target.cTypeBitSize`,
 * `cTypeAlignment` and `cMaxIntAlignment` for the C types, and `Type.abiAlignment`/`abiSize`
 * (src/Type.zig) for floats.
 * Only the branches for the architectures and operating systems listed here are ported.
 */
export type ZigArch = 'x86_64' | 'x86' | 'aarch64' | 'arm' | 'thumb' | 'riscv32' | 'riscv64' | 'wasm32' | 'avr' | 'powerpc' | 'mips';
export type ZigOs = 'linux' | 'windows' | 'macos' | 'freestanding';

export interface ZigTarget {
  /** What `-target` takes. */
  id: string;
  label: string;
  arch: ZigArch;
  os: ZigOs;
  abi: string;
  /** `-mcpu`, where the target needs one (AVR has no default CPU). */
  cpu?: string;
  description: string;
}

export const ZIG_TARGETS: readonly ZigTarget[] = [
  { id: 'x86_64-linux-gnu', label: 'x86-64 Linux', arch: 'x86_64', os: 'linux', abi: 'gnu', description: '64-bit Linux on Intel/AMD.' },
  { id: 'x86_64-windows-gnu', label: 'x86-64 Windows', arch: 'x86_64', os: 'windows', abi: 'gnu', description: "64-bit Windows with Zig's default ABI (MinGW): c_longdouble is the 80-bit x87 type." },
  { id: 'x86_64-windows-msvc', label: 'x86-64 Windows (MSVC)', arch: 'x86_64', os: 'windows', abi: 'msvc', description: '64-bit Windows linking with MSVC: c_longdouble is a double.' },
  { id: 'x86_64-macos-none', label: 'x86-64 macOS', arch: 'x86_64', os: 'macos', abi: 'none', description: 'Intel Macs.' },
  { id: 'aarch64-linux-gnu', label: 'AArch64 Linux', arch: 'aarch64', os: 'linux', abi: 'gnu', description: '64-bit ARM Linux (servers, Raspberry Pi OS 64-bit).' },
  { id: 'aarch64-macos-none', label: 'AArch64 macOS', arch: 'aarch64', os: 'macos', abi: 'none', description: 'Apple silicon Macs.' },
  { id: 'x86-linux-gnu', label: 'x86 Linux (32-bit)', arch: 'x86', os: 'linux', abi: 'gnu', description: '32-bit x86 Linux: u64, i64 and f64 are 4-byte aligned (System V i386).' },
  { id: 'x86-windows-gnu', label: 'x86 Windows (32-bit)', arch: 'x86', os: 'windows', abi: 'gnu', description: '32-bit Windows: 64-bit values are 8-byte aligned.' },
  { id: 'arm-linux-gnueabihf', label: 'ARMv7 Linux', arch: 'arm', os: 'linux', abi: 'gnueabihf', description: '32-bit ARM Linux (Raspberry Pi OS 32-bit).' },
  { id: 'thumb-freestanding-eabihf', label: 'Cortex-M4F (thumb)', arch: 'thumb', os: 'freestanding', abi: 'eabihf', cpu: 'cortex_m4', description: 'Bare-metal ARM Cortex-M4 with FPU.' },
  { id: 'riscv32-freestanding-none', label: 'RISC-V 32 (bare metal)', arch: 'riscv32', os: 'freestanding', abi: 'none', description: '32-bit RISC-V microcontrollers (ESP32-C3, GD32V).' },
  { id: 'riscv64-linux-gnu', label: 'RISC-V 64 Linux', arch: 'riscv64', os: 'linux', abi: 'gnu', description: '64-bit RISC-V Linux.' },
  { id: 'wasm32-freestanding-none', label: 'WebAssembly (wasm32)', arch: 'wasm32', os: 'freestanding', abi: 'none', description: 'wasm32: 32-bit pointers, 8-byte aligned 64-bit values.' },
  { id: 'avr-freestanding-none', label: 'AVR (ATmega328P)', arch: 'avr', os: 'freestanding', abi: 'none', cpu: 'atmega328p', description: 'AVR microcontrollers (Arduino Uno): 16-bit pointers, integers 1-byte aligned.' },
  { id: 'powerpc-linux-gnueabihf', label: 'PowerPC 32 Linux (big-endian)', arch: 'powerpc', os: 'linux', abi: 'gnueabihf', description: '32-bit big-endian PowerPC Linux: c_longdouble is a 128-bit double-double.' },
  { id: 'mips-linux-gnueabihf', label: 'MIPS32 Linux (big-endian)', arch: 'mips', os: 'linux', abi: 'gnueabihf', description: '32-bit big-endian MIPS Linux (routers).' },
];

export const DEFAULT_ZIG_TARGET = 'x86_64-linux-gnu';

export function getZigTarget(id: string): ZigTarget {
  return ZIG_TARGETS.find((t) => t.id === id) ?? ZIG_TARGETS[0]!;
}

/** A CPU model `-mcpu` selects, with the features that decide a layout. */
export interface ZigCpu {
  id: string;
  label: string;
  /** AVX and AVX-512F: Zig's x86-64 backend aligns vectors to 32 and 64 bytes with them. */
  avx: boolean;
  avx512f: boolean;
}

/** The x86-64 microarchitecture levels; `x86_64` is what -target builds for without -mcpu. */
export const ZIG_X86_64_CPUS: readonly ZigCpu[] = [
  { id: 'x86_64', label: 'Baseline x86-64', avx: false, avx512f: false },
  { id: 'x86_64_v2', label: 'x86-64-v2 (SSE4.2)', avx: false, avx512f: false },
  { id: 'x86_64_v3', label: 'x86-64-v3 (AVX2)', avx: true, avx512f: false },
  { id: 'x86_64_v4', label: 'x86-64-v4 (AVX-512)', avx: true, avx512f: true },
];

/** The CPU models offered for a target: the x86-64 levels, or the target's one CPU. */
export function zigCpus(t: ZigTarget): readonly ZigCpu[] {
  if (t.arch === 'x86_64') return ZIG_X86_64_CPUS;
  return [{ id: t.cpu ?? 'baseline', label: t.cpu ?? 'Baseline', avx: false, avx512f: false }];
}

/** The CPU `cpuId` names on `t`, or the target's default. */
export function getZigCpu(t: ZigTarget, cpuId?: string): ZigCpu {
  const cpus = zigCpus(t);
  return cpus.find((c) => c.id === cpuId) ?? cpus[0]!;
}

/** The flags that select a target, and a CPU, on the zig command line. */
export function zigTargetFlags(t: ZigTarget, cpuId?: string): string[] {
  const cpu = t.arch === 'x86_64' ? getZigCpu(t, cpuId).id : t.cpu;
  return ['-target', t.id, ...(cpu && cpu !== 'x86_64' ? [`-mcpu=${cpu}`] : [])];
}

export function ptrBits(t: ZigTarget): number {
  switch (t.arch) {
    case 'x86_64':
    case 'aarch64':
    case 'riscv64':
      return 64;
    case 'avr':
      return 16;
    default:
      return 32;
  }
}

export function isBigEndian(t: ZigTarget): boolean {
  return t.arch === 'powerpc' || t.arch === 'mips';
}

export type ObjectFormat = 'elf' | 'coff' | 'macho' | 'wasm';

export function objectFormat(t: ZigTarget): ObjectFormat {
  if (t.arch === 'wasm32') return 'wasm';
  if (t.os === 'windows') return 'coff';
  if (t.os === 'macos') return 'macho';
  return 'elf';
}

export type ZigBuildMode = 'Debug' | 'ReleaseSafe' | 'ReleaseFast' | 'ReleaseSmall';
export const ZIG_BUILD_MODES: readonly ZigBuildMode[] = ['Debug', 'ReleaseSafe', 'ReleaseFast', 'ReleaseSmall'];

/** The std.lang.Optimize field of each mode: 0.17's -O also takes these names (debug, safe, fast, small). */
export const OPTIMIZE_FIELD: Readonly<Record<ZigBuildMode, string>> = { Debug: 'debug', ReleaseSafe: 'safe', ReleaseFast: 'fast', ReleaseSmall: 'small' };

/** Debug and ReleaseSafe: bare unions carry a hidden tag that checks which field is active. */
export function runtimeSafety(mode: ZigBuildMode): boolean {
  return mode === 'Debug' || mode === 'ReleaseSafe';
}

/**
 * The code generator (Compilation.Config): LLVM for release builds; in Debug, Zig's own x86-64
 * backend where it is as robust as LLVM (`selfHostedBackendIsAsRobustAsLlvm`): 64-bit ELF, but not
 * the BSDs, which `isBSD()` takes to include macOS. The backends agree on every layout but that of
 * vectors.
 */
export function zigBackend(t: ZigTarget, mode: ZigBuildMode): 'llvm' | 'x86_64' {
  if (mode !== 'Debug') return 'llvm';
  return t.arch === 'x86_64' && t.os !== 'macos' && objectFormat(t) === 'elf' ? 'x86_64' : 'llvm';
}

const ceilPow2 = (n: number) => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};
const alignForward = (n: number, a: number) => Math.ceil(n / a) * a;

/** `Target.cMaxIntAlignment`. */
export function cMaxIntAlignment(t: ZigTarget): number {
  switch (t.arch) {
    case 'avr':
      return 1;
    case 'x86':
      return t.os === 'windows' ? 8 : 4;
    case 'arm':
    case 'thumb':
    case 'mips':
    case 'powerpc':
    case 'riscv32':
      return 8;
    default:
      return 16;
  }
}

/** `std.zig.target.intAlignment`: the integer's bytes rounded up to a power of two, at most cMaxIntAlignment. */
export function intAlignment(t: ZigTarget, bits: number): number {
  if (bits === 0) return 1;
  return Math.min(ceilPow2(Math.ceil(bits / 8)), cMaxIntAlignment(t));
}

/** `std.zig.target.intByteSize`. */
export function intByteSize(t: ZigTarget, bits: number): number {
  return alignForward(Math.ceil(bits / 8), intAlignment(t, bits));
}

export type CType = 'char' | 'short' | 'ushort' | 'int' | 'uint' | 'long' | 'ulong' | 'longlong' | 'ulonglong' | 'float' | 'double' | 'longdouble';

/** `Target.cTypeBitSize`. */
export function cTypeBitSize(t: ZigTarget, c: CType): number {
  const common = (long: number, longdouble: number): number => {
    switch (c) {
      case 'char':
        return 8;
      case 'short':
      case 'ushort':
        return 16;
      case 'int':
      case 'uint':
      case 'float':
        return 32;
      case 'long':
      case 'ulong':
        return long;
      case 'longlong':
      case 'ulonglong':
      case 'double':
        return 64;
      case 'longdouble':
        return longdouble;
    }
  };
  // The generic branch: long is pointer-sized; long double by architecture.
  const genericLongDouble = (): number => {
    switch (t.arch) {
      case 'x86':
        return 80;
      case 'powerpc':
        return 128;
      case 'riscv32':
      case 'riscv64':
      case 'aarch64':
      case 'wasm32':
        return 128;
      default:
        return 64;
    }
  };
  switch (t.os) {
    case 'freestanding':
      if (t.arch === 'avr') {
        switch (c) {
          case 'char':
            return 8;
          case 'short':
          case 'ushort':
          case 'int':
          case 'uint':
            return 16;
          case 'longlong':
          case 'ulonglong':
            return 64;
          default:
            return 32;
        }
      }
      if (t.arch === 'x86_64') return common(64, 80);
      return common(ptrBits(t), genericLongDouble());
    case 'linux':
      if (t.arch === 'x86_64') return common(64, 80);
      return common(ptrBits(t), genericLongDouble());
    case 'windows': {
      const msvcLongDouble = t.abi === 'gnu' ? 80 : 64;
      return common(32, t.arch === 'x86' || t.arch === 'x86_64' ? msvcLongDouble : 64);
    }
    case 'macos':
      return common(64, t.arch === 'x86_64' ? 80 : 64);
  }
}

/**
 * `Target.cTypeByteSize`. Its long double cases are 64, 80 and 128 bits; AVR's 32-bit long double
 * reaches the switch's `unreachable`, and the released compiler (a ReleaseFast build, where that is
 * undefined) answers as for 80 bits: 10 bytes, which is what zig 0.17 gives @sizeOf(c_longdouble).
 */
export function cTypeByteSize(t: ZigTarget, c: CType): number {
  const bits = cTypeBitSize(t, c);
  if (c !== 'longdouble') return bits / 8;
  if (bits === 64) return 8;
  if (bits === 128) return 16;
  return alignForward(10, cTypeAlignment(t, c));
}

/** `Target.cTypeAlignment`. */
export function cTypeAlignment(t: ZigTarget, c: CType): number {
  if (t.arch === 'avr') return 1;
  if (t.arch === 'x86' && t.os === 'windows') {
    if (c === 'longlong' || c === 'ulonglong' || c === 'double') return 8;
    if (c === 'longdouble') return t.abi === 'gnu' ? 4 : 8;
  }
  const cap = t.arch === 'x86' ? 4 : t.arch === 'arm' || t.arch === 'thumb' || t.arch === 'mips' ? 8 : 16;
  return Math.min(ceilPow2(Math.ceil(cTypeBitSize(t, c) / 8)), cap);
}

/**
 * `target_util.minFunctionAlignment` (src/target.zig): a function type's alignment. The RISC-V
 * CPUs here have the C extension, which allows 2.
 */
export function minFunctionAlignment(t: ZigTarget): number {
  switch (t.arch) {
    case 'riscv32':
    case 'riscv64':
    case 'thumb':
      return 2;
    case 'aarch64':
    case 'arm':
    case 'mips':
    case 'powerpc':
      return 4;
    default:
      return 1;
  }
}

/** `Target.stackAlignment` (no RISC-V CPU here has the E extension). */
export function stackAlignment(t: ZigTarget): number {
  switch (t.arch) {
    case 'arm':
    case 'thumb':
    case 'mips':
      return 8;
    case 'aarch64':
    case 'wasm32':
    case 'x86_64':
    case 'riscv32':
    case 'riscv64':
      return 16;
    case 'x86':
      if (t.os !== 'windows') return 16;
      return ptrBits(t) / 8;
    default:
      return ptrBits(t) / 8;
  }
}

/**
 * `std.zig.target.compilerRtFloatAbi`: whether a float of this width is a hardware (C) type on the
 * target or emulated in software. (None of the targets here has x86's soft_float feature.)
 */
export function compilerRtFloatAbi(t: ZigTarget, bits: number): 'hard' | 'soft' {
  switch (bits) {
    case 16:
      return t.arch === 'mips' || t.arch === 'powerpc' ? 'soft' : 'hard';
    case 80:
      return cTypeBitSize(t, 'longdouble') !== 80 ? 'soft' : 'hard';
    case 128:
      if (t.arch === 'x86' || t.arch === 'x86_64') return 'hard';
      return cTypeBitSize(t, 'longdouble') !== 128 ? 'soft' : 'hard';
    default:
      return 'hard';
  }
}

/** Size and alignment of f16..f128 (`Type.abiSize`, `Type.abiAlignment`). */
export function floatLayout(t: ZigTarget, bits: 16 | 32 | 64 | 80 | 128): { size: number; align: number } {
  const asInt = (n: number) => ({ size: intByteSize(t, n), align: intAlignment(t, n) });
  switch (bits) {
    case 16:
      return asInt(16);
    case 32:
      return cTypeBitSize(t, 'float') === 32 ? { size: cTypeByteSize(t, 'float'), align: cTypeAlignment(t, 'float') } : asInt(32);
    case 64:
      return cTypeBitSize(t, 'double') === 64 ? { size: cTypeByteSize(t, 'double'), align: cTypeAlignment(t, 'double') } : asInt(64);
    case 80: {
      if (cTypeBitSize(t, 'longdouble') === 80) return { size: cTypeByteSize(t, 'longdouble'), align: cTypeAlignment(t, 'longdouble') };
      if (compilerRtFloatAbi(t, 80) === 'hard') return asInt(80);
      // A u64 mantissa and a u16 exponent.
      const align = Math.max(intAlignment(t, 64), intAlignment(t, 16));
      return { size: alignForward(intByteSize(t, 64) + intByteSize(t, 16), align), align };
    }
    case 128:
      if (cTypeBitSize(t, 'longdouble') === 128) return { size: cTypeByteSize(t, 'longdouble'), align: cTypeAlignment(t, 'longdouble') };
      if (compilerRtFloatAbi(t, 128) === 'hard') return t.arch === 'x86' || t.arch === 'x86_64' ? { size: 16, align: 16 } : asInt(128);
      // Two u64 halves.
      return { size: intByteSize(t, 64) * 2, align: intAlignment(t, 64) };
  }
}
