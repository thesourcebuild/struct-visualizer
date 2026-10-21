/**
 * Rust targets. Scalar alignments come from each target's LLVM data layout as rustc uses it
 * (i686 Linux aligns u64/f64 to 4; x86 and 64-bit RISC-V align u128 to 16 since Rust 1.77;
 * 32-bit ARM to 8; AVR aligns everything to 1).
 */
export interface RustTarget {
  /** Target triple. */
  id: string;
  label: string;
  /** usize, isize and thin pointers. */
  pointerBytes: number;
  /** Pointer alignment: the pointer size, except on AVR (p:16:8). */
  pointerAlign: number;
  align: { i16: number; i32: number; i64: number; i128: number; f32: number; f64: number };
  /** core::ffi::c_int and c_long. */
  cIntBytes: number;
  cLongBytes: number;
  /** Smallest discriminant of a repr(C) enum (rustc's c_enum_min_bits). */
  cEnumMinBytes: number;
  /** Checked against rustc by the test suite (the target's standard library is installed). */
  verified: boolean;
  description: string;
}

const X86_64 = { i16: 2, i32: 4, i64: 8, i128: 16, f32: 4, f64: 8 };

export const RUST_TARGETS: readonly RustTarget[] = [
  { id: 'x86_64-unknown-linux-gnu', label: 'x86-64 Linux', pointerBytes: 8, pointerAlign: 8, align: X86_64, cIntBytes: 4, cLongBytes: 8, cEnumMinBytes: 4, verified: false, description: '64-bit Linux on Intel/AMD.' },
  { id: 'x86_64-pc-windows-msvc', label: 'x86-64 Windows (MSVC)', pointerBytes: 8, pointerAlign: 8, align: X86_64, cIntBytes: 4, cLongBytes: 4, cEnumMinBytes: 4, verified: true, description: '64-bit Windows.' },
  { id: 'x86_64-apple-darwin', label: 'x86-64 macOS', pointerBytes: 8, pointerAlign: 8, align: X86_64, cIntBytes: 4, cLongBytes: 8, cEnumMinBytes: 4, verified: false, description: 'Intel Macs.' },
  { id: 'aarch64-unknown-linux-gnu', label: 'AArch64 Linux', pointerBytes: 8, pointerAlign: 8, align: X86_64, cIntBytes: 4, cLongBytes: 8, cEnumMinBytes: 4, verified: false, description: '64-bit ARM Linux (servers, Raspberry Pi OS 64-bit).' },
  { id: 'aarch64-apple-darwin', label: 'AArch64 macOS', pointerBytes: 8, pointerAlign: 8, align: X86_64, cIntBytes: 4, cLongBytes: 8, cEnumMinBytes: 4, verified: false, description: 'Apple silicon Macs.' },
  { id: 'i686-unknown-linux-gnu', label: 'x86 Linux (32-bit)', pointerBytes: 4, pointerAlign: 4, align: { i16: 2, i32: 4, i64: 4, i128: 16, f32: 4, f64: 4 }, cIntBytes: 4, cLongBytes: 4, cEnumMinBytes: 4, verified: false, description: '32-bit x86 Linux: u64, i64 and f64 are 4-byte aligned (System V i386).' },
  { id: 'i686-pc-windows-msvc', label: 'x86 Windows (32-bit)', pointerBytes: 4, pointerAlign: 4, align: { i16: 2, i32: 4, i64: 8, i128: 16, f32: 4, f64: 8 }, cIntBytes: 4, cLongBytes: 4, cEnumMinBytes: 4, verified: false, description: '32-bit Windows: 64-bit values are 8-byte aligned.' },
  { id: 'armv7-unknown-linux-gnueabihf', label: 'ARMv7 Linux', pointerBytes: 4, pointerAlign: 4, align: { i16: 2, i32: 4, i64: 8, i128: 8, f32: 4, f64: 8 }, cIntBytes: 4, cLongBytes: 4, cEnumMinBytes: 4, verified: false, description: '32-bit ARM Linux (Raspberry Pi OS 32-bit).' },
  { id: 'thumbv7em-none-eabihf', label: 'Cortex-M4F/M7F (thumbv7em)', pointerBytes: 4, pointerAlign: 4, align: { i16: 2, i32: 4, i64: 8, i128: 8, f32: 4, f64: 8 }, cIntBytes: 4, cLongBytes: 4, cEnumMinBytes: 1, verified: true, description: 'Bare-metal ARM Cortex-M with FPU. repr(C) enums are as small as their values allow, as with arm-none-eabi GCC.' },
  { id: 'riscv32imac-unknown-none-elf', label: 'RISC-V 32 (bare metal)', pointerBytes: 4, pointerAlign: 4, align: { i16: 2, i32: 4, i64: 8, i128: 8, f32: 4, f64: 8 }, cIntBytes: 4, cLongBytes: 4, cEnumMinBytes: 4, verified: false, description: '32-bit RISC-V microcontrollers (ESP32-C3, GD32V).' },
  { id: 'riscv64gc-unknown-linux-gnu', label: 'RISC-V 64 Linux', pointerBytes: 8, pointerAlign: 8, align: X86_64, cIntBytes: 4, cLongBytes: 8, cEnumMinBytes: 4, verified: false, description: '64-bit RISC-V Linux.' },
  { id: 'wasm32-unknown-unknown', label: 'WebAssembly (wasm32)', pointerBytes: 4, pointerAlign: 4, align: { i16: 2, i32: 4, i64: 8, i128: 16, f32: 4, f64: 8 }, cIntBytes: 4, cLongBytes: 4, cEnumMinBytes: 4, verified: false, description: 'wasm32: 32-bit pointers, 8-byte aligned 64-bit values.' },
  { id: 'avr-none', label: 'AVR (8-bit)', pointerBytes: 2, pointerAlign: 1, align: { i16: 1, i32: 1, i64: 1, i128: 1, f32: 1, f64: 1 }, cIntBytes: 2, cLongBytes: 4, cEnumMinBytes: 2, verified: false, description: 'AVR microcontrollers (Arduino): 16-bit pointers, everything 1-byte aligned.' },
];

export function getRustTarget(id: string): RustTarget {
  return RUST_TARGETS.find((t) => t.id === id) ?? RUST_TARGETS[0]!;
}
