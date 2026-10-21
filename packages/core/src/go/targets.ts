/**
 * Go targets. For gc, layout depends only on GOARCH: the word size and the maximum alignment,
 * exactly as in go/types' gcArchSizes (types.SizesFor("gc", arch)).
 */
export type GoCompiler = 'gc' | 'tinygo';

export interface GoTarget {
  id: string;
  label: string;
  compiler: GoCompiler;
  /** Size of int, uint, uintptr and pointers. */
  wordSize: number;
  /** Largest alignment of any type; 64-bit values are only 4-aligned when this is 4. */
  maxAlign: number;
  /** Verified against a real compiler by the test suite. */
  verified: boolean;
  description: string;
}

export const GO_TARGETS: readonly GoTarget[] = [
  { id: 'amd64', label: 'amd64 (x86-64)', compiler: 'gc', wordSize: 8, maxAlign: 8, verified: true, description: 'Intel/AMD 64-bit: Linux, Windows, macOS.' },
  { id: 'arm64', label: 'arm64 (AArch64)', compiler: 'gc', wordSize: 8, maxAlign: 8, verified: true, description: 'Apple silicon, ARM servers, Raspberry Pi 64-bit.' },
  { id: '386', label: '386 (x86 32-bit)', compiler: 'gc', wordSize: 4, maxAlign: 4, verified: true, description: '32-bit x86. 64-bit integers and floats are only 4-byte aligned.' },
  { id: 'arm', label: 'arm (32-bit)', compiler: 'gc', wordSize: 4, maxAlign: 4, verified: true, description: '32-bit ARM (GOARM 5-7). 64-bit values are only 4-byte aligned.' },
  { id: 'riscv64', label: 'riscv64', compiler: 'gc', wordSize: 8, maxAlign: 8, verified: true, description: '64-bit RISC-V.' },
  { id: 'loong64', label: 'loong64', compiler: 'gc', wordSize: 8, maxAlign: 8, verified: true, description: 'LoongArch 64-bit.' },
  { id: 'mips', label: 'mips (32-bit, big-endian)', compiler: 'gc', wordSize: 4, maxAlign: 4, verified: true, description: '32-bit MIPS, big-endian.' },
  { id: 'mipsle', label: 'mipsle (32-bit)', compiler: 'gc', wordSize: 4, maxAlign: 4, verified: true, description: '32-bit MIPS, little-endian.' },
  { id: 'mips64', label: 'mips64', compiler: 'gc', wordSize: 8, maxAlign: 8, verified: true, description: '64-bit MIPS, big-endian.' },
  { id: 'mips64le', label: 'mips64le', compiler: 'gc', wordSize: 8, maxAlign: 8, verified: true, description: '64-bit MIPS, little-endian.' },
  { id: 'ppc64', label: 'ppc64', compiler: 'gc', wordSize: 8, maxAlign: 8, verified: true, description: '64-bit POWER, big-endian.' },
  { id: 'ppc64le', label: 'ppc64le', compiler: 'gc', wordSize: 8, maxAlign: 8, verified: true, description: '64-bit POWER, little-endian.' },
  { id: 's390x', label: 's390x', compiler: 'gc', wordSize: 8, maxAlign: 8, verified: true, description: 'IBM Z.' },
  { id: 'wasm', label: 'wasm (js/wasip1)', compiler: 'gc', wordSize: 8, maxAlign: 8, verified: true, description: 'WebAssembly with the gc compiler (64-bit int and pointers).' },
];

export function getGoTarget(id: string): GoTarget {
  return GO_TARGETS.find((t) => t.id === id) ?? GO_TARGETS[0];
}
