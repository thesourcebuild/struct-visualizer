import type { Architecture } from '../types';

// x86 (32-bit Intel/AMD)
export const x86Architecture: Architecture = {
  id: 'x86',
  name: 'x86',
  displayName: 'Intel x86 (32-bit)',
  description: 'Standard 32-bit x86 architecture (IA-32)',
};

// x64 (64-bit Intel/AMD)
export const x64Architecture: Architecture = {
  id: 'x64',
  name: 'x64',
  displayName: 'Intel x64 (64-bit)',
  description: 'Standard 64-bit x86-64 architecture (AMD64/Intel 64)',
};

// ARM32 (32-bit ARM)
export const arm32Architecture: Architecture = {
  id: 'arm32',
  name: 'arm32',
  displayName: 'ARM 32-bit',
  description: 'ARM 32-bit architecture (ARMv7)',
};

// ARM64 (AArch64)
export const arm64Architecture: Architecture = {
  id: 'arm64',
  name: 'arm64',
  displayName: 'ARM 64-bit (AArch64)',
  description: 'ARM 64-bit architecture (ARMv8-A)',
};

// 8051 (8-bit microcontroller)
export const arch8051: Architecture = {
  id: '8051',
  name: '8051',
  displayName: '8051 Microcontroller',
  description: 'Intel 8051 8-bit microcontroller',
};

// Microchip (Atmel 8-bit)
export const avrArchitecture: Architecture = {
  id: 'avr',
  name: 'avr',
  displayName: 'Microchip (Atmel) 8-bit',
  description: 'AVR 8-bit microcontroller (avr-gcc ABI)',
};

// PIC (Microchip 16-bit)
export const pic16Architecture: Architecture = {
  id: 'pic16',
  name: 'pic16',
  displayName: 'Microchip (Atmel) 16-bit',
  description: 'Microchip PIC16 16-bit microcontroller',
};

// PIC32 (Microchip 32-bit)
export const pic32Architecture: Architecture = {
  id: 'pic32',
  name: 'pic32',
  displayName: 'Microchip (Atmel) 32-bit',
  description: 'Microchip PIC32 32-bit microcontroller (MIPS-based)',
};

// RISC-V (32-bit)
export const riscv32Architecture: Architecture = {
  id: 'riscv32',
  name: 'riscv32',
  displayName: 'RISC-V 32-bit',
  description: 'RISC-V 32-bit architecture (RV32)',
};

// RISC-V (64-bit)
export const riscv64Architecture: Architecture = {
  id: 'riscv64',
  name: 'riscv64',
  displayName: 'RISC-V 64-bit',
  description: 'RISC-V 64-bit architecture (RV64)',
};

export const architectures: Record<string, Architecture> = {
  x86: x86Architecture,
  x64: x64Architecture,
  arm32: arm32Architecture,
  arm64: arm64Architecture,
  riscv32: riscv32Architecture,
  riscv64: riscv64Architecture,
  '8051': arch8051,
  avr: avrArchitecture,
  pic16: pic16Architecture,
  pic32: pic32Architecture
};

export const architectureList = [
  x86Architecture,
  x64Architecture,
  arm32Architecture,
  arm64Architecture,
  riscv32Architecture,
  riscv64Architecture,
  arch8051,
  avrArchitecture,
  pic16Architecture,
  pic32Architecture,
];
