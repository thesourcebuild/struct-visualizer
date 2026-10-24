import type { CalculationResult, StructMember } from '../types';
import type { ResolvedPlatform } from '../abi/resolve-selection';
import type { PaddingCalculator } from '../layout/padding-calculator';

/**
 * Bindings: the laid-out C struct written in another language so that it has exactly the same
 * size and member offsets on the selected target. Each language places fields by its own rules,
 * so each emitter is told how its language places them and adds what the C layout needs on top:
 * explicit padding, an alignment, or explicit offsets. Every binding is compiled and its offsets
 * checked against the C layout in tests/bindings.test.ts.
 */
export type BindingLanguage = 'rust' | 'zig' | 'go' | 'csharp' | 'python-struct' | 'python-ctypes';

export const bindingLanguages: Record<BindingLanguage, { label: string; extension: string; summary: string }> = {
  rust: { label: 'Rust', extension: 'rs', summary: '#[repr(C)] structs and unions, for the target triple named in the file.' },
  zig: { label: 'Zig', extension: 'zig', summary: 'extern structs and unions, with field alignments where C has its own.' },
  go: { label: 'Go', extension: 'go', summary: 'Structs with explicit padding fields, for the GOARCH named in the file.' },
  csharp: { label: 'C#', extension: 'cs', summary: '[StructLayout(LayoutKind.Explicit)] with every field at its offset: the same on any machine.' },
  'python-struct': { label: 'Python struct', extension: 'py', summary: 'struct format strings in the target byte order with explicit pad bytes, to read and write raw data.' },
  'python-ctypes': { label: 'Python ctypes', extension: 'py', summary: 'ctypes Structures in the target byte order, packed with explicit padding: the same on any machine.' },
};

export interface BindingOutput {
  code: string;
  filename: string;
  /** What the binding cannot carry over, said plainly: bit-fields as bytes, a different alignment. */
  notes: string[];
  /** Set when no exact binding exists for this target or struct; code is then empty. */
  error?: string;
}

// ------------------------------------------------------------------ the model

type BType =
  | { kind: 'int'; size: number; signed: boolean }
  | { kind: 'float'; size: 4 | 8 }
  | { kind: 'bool' }
  | { kind: 'pointer'; size: number; function: boolean }
  | { kind: 'record'; record: Record_ }
  | { kind: 'bytes'; size: number }
  | { kind: 'array'; dims: number[]; element: BType };

type Item =
  /** A C member at its offset; `align` is the alignment it has in this struct, `natural` its type's own. */
  | { kind: 'field'; name: string; offset: number; size: number; align: number; natural: number; type: BType; note?: string }
  /** A run of bit-fields, carried as the bytes their bits occupy. */
  | { kind: 'bits'; name: string; offset: number; size: number; fields: Array<{ name: string; bit: number; width: number }> };

interface Record_ {
  name: string;
  union: boolean;
  size: number;
  align: number;
  /** `#pragma pack(n)` or packed: the largest alignment a member gets (Rust's packed(n)). */
  pack?: number;
  items: Item[];
  /** C's own name for it, for comments. */
  cName: string;
}

const KEYWORDS: Record<BindingLanguage, ReadonlySet<string>> = {
  rust: new Set(['as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'async', 'await', 'dyn', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try', 'gen']),
  zig: new Set(['addrspace', 'align', 'allowzero', 'and', 'anyframe', 'anytype', 'asm', 'break', 'callconv', 'catch', 'comptime', 'const', 'continue', 'defer', 'else', 'enum', 'errdefer', 'error', 'export', 'extern', 'fn', 'for', 'if', 'inline', 'noalias', 'nosuspend', 'noinline', 'opaque', 'or', 'orelse', 'packed', 'pub', 'resume', 'return', 'linksection', 'struct', 'suspend', 'switch', 'test', 'threadlocal', 'try', 'union', 'unreachable', 'usingnamespace', 'var', 'volatile', 'while', 'type', 'void', 'bool', 'null', 'undefined', 'true', 'false']),
  go: new Set(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var']),
  csharp: new Set(['abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while']),
  'python-struct': new Set(),
  'python-ctypes': new Set(['_fields_', '_pack_', '_layout_', '_anonymous_']),
};

function ident(name: string, language: BindingLanguage): string {
  if (!KEYWORDS[language].has(name)) return name;
  switch (language) {
    case 'rust': return `r#${name}`;
    case 'zig': return `@"${name}"`;
    case 'csharp': return `@${name}`;
    default: return `${name}_`;
  }
}

const SIGNED = new Set(['char', 'signed char', 'short', 'int', 'long', 'long long', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'intptr_t', 'ptrdiff_t', 'ssize_t', 'wchar_t']);

/** Builds the model of a laid-out record and the records it contains. */
class ModelBuilder {
  readonly records: Record_[] = [];
  private readonly byStruct = new Map<string, Record_>();
  readonly notes: string[] = [];

  constructor(
    private readonly calculator: PaddingCalculator,
    private readonly platform: ResolvedPlatform,
  ) {}

  record(result: CalculationResult, name: string): Record_ {
    const key = `${result.struct.isUnion ? 'union' : 'struct'} ${result.struct.name}`;
    const known = this.byStruct.get(key);
    if (known) return known;
    const def = result.struct;
    const record: Record_ = {
      name,
      cName: def.name.startsWith('__anon_') ? `(anonymous ${def.isUnion ? 'union' : 'struct'})` : key,
      union: def.isUnion === true,
      size: result.totalSize,
      align: def.alignment ?? 1,
      ...(def.packed ? { pack: 1 } : def.pragmaPack !== undefined ? { pack: def.pragmaPack } : {}),
      items: [],
    };
    this.byStruct.set(key, record);
    let anonymous = 0;
    const entries = result.members;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const m = e.member;
      if (m.role) throw new BindingError(`${record.cName} is a C++ class with base classes or virtual functions, which no other language lays out the same way.`);
      if (m.bitField !== undefined) {
        if (m.bitField === 0) continue;
        // Consecutive bit-fields share their bytes; a union's each start at 0.
        const run = [e];
        while (!record.union && entries[i + 1]?.member.bitField !== undefined) run.push(entries[++i]);
        const fields = run.filter((r) => r.member.bitField! > 0).map((r) => ({ name: r.member.name || '(unnamed)', bit: (r.bitOffset ?? r.offset * 8) - run[0].offset * 8, width: r.member.bitField! }));
        if (fields.length === 0) continue;
        const start = Math.min(...run.map((r) => r.offset));
        const end = Math.max(...run.map((r) => r.offset + r.size));
        const named = fields.filter((f) => f.name !== '(unnamed)').map((f) => f.name);
        record.items.push({ kind: 'bits', name: `bits_${named.join('_') || start}`, offset: start, size: end - start, fields });
        continue;
      }
      const fieldName = m.name || `anon${anonymous++}`;
      const type = this.typeOf(m, e, `${name}_${fieldName}`);
      // The plain type's alignment, which is what another language's equivalent type has: no
      // request on the member, no aligned typedef.
      const natural = this.calculator.measure({ ...m, alignAttribute: undefined, packed: undefined, typeAlignment: undefined }).alignment;
      record.items.push({ kind: 'field', name: fieldName, offset: e.offset, size: e.size, align: e.alignment, natural, type });
    }
    this.records.push(record);
    return record;
  }

  private typeOf(m: StructMember, e: CalculationResult['members'][number], nestedName: string): BType {
    const dims = m.arrayDims ?? (m.arraySize !== undefined ? [m.arraySize] : []);
    const count = dims.reduce((a, b) => a * b, 1);
    const elementSize = dims.length === 0 ? e.size : count > 0 ? e.size / count : this.calculator.measure({ ...m, arraySize: undefined, arrayDims: undefined }).size;
    const element = this.scalarOf(m, elementSize, e.nested, nestedName);
    return dims.length > 0 ? { kind: 'array', dims, element } : element;
  }

  private scalarOf(m: StructMember, size: number, nested: CalculationResult | undefined, nestedName: string): BType {
    if (m.isNested && nested && !m.type.includes('*')) {
      const name = nested.struct.name.startsWith('__anon_') ? nestedName : nested.struct.name;
      return { kind: 'record', record: this.record(nested, name) };
    }
    if (m.type.includes('*') || m.functionPointer || m.reference) return { kind: 'pointer', size, function: m.functionPointer === true };
    if (m.enumType) return { kind: 'int', size, signed: m.enumType.members.some((v) => (v.value ?? 0) < 0) };
    const type = m.type.replace(/\b(const|volatile)\b/g, '').replace(/\s+/g, ' ').trim();
    if (type === 'float' && size === 4) return { kind: 'float', size: 4 };
    if (type === 'double' && size === 8) return { kind: 'float', size: 8 };
    if (type === 'long double' && size === 8) return { kind: 'float', size: 8 };
    if (/\b(float|double|_Complex)\b/.test(type) || type === '__int128' || type === 'unsigned __int128') {
      this.notes.push(`'${m.name}' (${type}, ${size} bytes) has no fixed-size equivalent and is carried as ${size} bytes.`);
      return { kind: 'bytes', size };
    }
    if (type === '_Bool' || type === 'bool') return { kind: 'bool' };
    if (size === 1 || size === 2 || size === 4 || size === 8) {
      const signed = SIGNED.has(type) || (!type.startsWith('unsigned') && !/^u|size_t|char(8|16|32)_t/.test(type) && type !== 'wchar_t');
      return { kind: 'int', size, signed };
    }
    this.notes.push(`'${m.name}' (${type}, ${size} bytes) is carried as ${size} bytes.`);
    return { kind: 'bytes', size };
  }
}

class BindingError extends Error {}

// ------------------------------------------------------------------ placement

/** What a language puts between and after the fields to give them the C offsets and size. */
type Placed = Array<{ item: Item; bytes?: boolean } | { pad: number; name: string }>;

/**
 * Place the items as a language with natural alignment does (each at the next offset its
 * `align` allows), with explicit padding where C leaves more. A field the language would place
 * later than C did (C packed it) is carried as bytes. Returns the placement and the language's
 * own size and alignment for the record without an alignment attribute.
 */
function placeNatural(record: Record_, align: (item: Item) => number): { placed: Placed; size: number; align: number } {
  const placed: Placed = [];
  let pos = 0;
  let maxAlign = 1;
  let pads = 0;
  for (const item of record.items) {
    let a = align(item);
    let bytes = false;
    if (record.union) {
      placed.push({ item });
      maxAlign = Math.max(maxAlign, a);
      pos = Math.max(pos, item.size);
      continue;
    }
    if (alignTo(pos, a) > item.offset) {
      // The language would not put it as early as C does: carry its bytes, which align to 1.
      bytes = true;
      a = 1;
    }
    // Padding only where the language would not reach C's offset by aligning the field itself.
    if (alignTo(pos, a) < item.offset) {
      placed.push({ pad: item.offset - pos, name: `_pad${pads++}` });
    }
    placed.push(bytes ? { item, bytes } : { item });
    maxAlign = Math.max(maxAlign, a);
    pos = item.offset + item.size;
  }
  if (alignTo(pos, maxAlign) < record.size) {
    placed.push({ pad: record.size - pos, name: `_pad${pads++}` });
    pos = record.size;
  }
  return { placed, size: alignTo(pos, maxAlign), align: maxAlign };
}

const alignTo = (n: number, a: number) => Math.ceil(n / Math.max(1, a)) * Math.max(1, a);

function bitsComment(item: Extract<Item, { kind: 'bits' }>, bigEndian: boolean): string {
  const order = bigEndian ? 'from the most significant bit of its first byte' : 'from the least significant bit of its first byte';
  return `bit-fields, bits counted ${order}: ${item.fields.map((f) => `${f.name} ${f.bit}..${f.bit + f.width - 1}`).join(', ')}`;
}

// ------------------------------------------------------------------ targets per language

/** Rust's target triple for each platform, where Rust has one. */
function rustTarget(p: ResolvedPlatform): string | undefined {
  const linux = p.os === 'linux';
  switch (p.target) {
    case 'intel-x64-amd': return p.os === 'windows' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
    case 'intel-x86': return p.os === 'windows' ? 'i686-pc-windows-msvc' : 'i686-unknown-linux-gnu';
    case 'arm32': return linux ? 'armv7-unknown-linux-gnueabihf' : 'thumbv7em-none-eabihf';
    case 'arm64': return linux ? 'aarch64-unknown-linux-gnu' : 'aarch64-unknown-none';
    case 'riscv32': return linux ? 'riscv32gc-unknown-linux-gnu' : 'riscv32imac-unknown-none-elf';
    case 'riscv64': return linux ? 'riscv64gc-unknown-linux-gnu' : 'riscv64gc-unknown-none-elf';
    case 'powerpc32': return 'powerpc-unknown-linux-gnu';
    case 'mips32-be': return linux ? 'mips-unknown-linux-gnu' : undefined;
    case 'microchip-32bit': return 'mipsel-unknown-none';
    case 'microchip-8bit': return 'avr-none';
    default: return undefined;
  }
}

/** Zig's target for each platform; Zig carries every C ABI it targets. */
function zigTarget(p: ResolvedPlatform): string | undefined {
  const linux = p.os === 'linux';
  switch (p.target) {
    case 'intel-x64-amd': return p.os === 'windows' ? 'x86_64-windows-msvc' : 'x86_64-linux-gnu';
    case 'intel-x86': return p.os === 'windows' ? 'x86-windows-msvc' : 'x86-linux-gnu';
    case 'arm32': return linux ? 'arm-linux-gnueabihf' : 'thumb-freestanding-eabihf -mcpu=cortex_m4';
    case 'arm64': return linux ? 'aarch64-linux-gnu' : 'aarch64-freestanding';
    case 'riscv32': return linux ? 'riscv32-linux-gnu' : 'riscv32-freestanding';
    case 'riscv64': return linux ? 'riscv64-linux-gnu' : 'riscv64-freestanding';
    case 'powerpc32': return 'powerpc-linux-gnueabihf';
    case 'mips32-be': return linux ? 'mips-linux-gnueabihf' : 'mips-freestanding';
    case 'microchip-32bit': return 'mipsel-freestanding';
    case 'microchip-8bit': return 'avr-freestanding -mcpu=atmega328p';
    default: return undefined;
  }
}

/** Go's port for each platform, where Go has one: GOARCH and its largest alignment. */
function goTarget(p: ResolvedPlatform): { arch: string; maxAlign: number } | undefined {
  switch (p.target) {
    case 'intel-x64-amd': return { arch: 'amd64', maxAlign: 8 };
    case 'intel-x86': return { arch: '386', maxAlign: 4 };
    case 'arm32': return p.os === 'linux' ? { arch: 'arm', maxAlign: 4 } : undefined;
    case 'arm64': return p.os === 'linux' ? { arch: 'arm64', maxAlign: 8 } : undefined;
    case 'riscv64': return p.os === 'linux' ? { arch: 'riscv64', maxAlign: 8 } : undefined;
    case 'mips32-be': return p.os === 'linux' ? { arch: 'mips', maxAlign: 4 } : undefined;
    default: return undefined;
  }
}

export function bindingTargetName(language: BindingLanguage, p: ResolvedPlatform): string | undefined {
  if (language === 'rust') return rustTarget(p);
  if (language === 'zig') return zigTarget(p);
  if (language === 'go') return goTarget(p)?.arch;
  return undefined;
}

// ------------------------------------------------------------------ entry point

/** The binding of `result` (laid out for `platform`) in `language`. */
export function generateBindings(result: CalculationResult, platform: ResolvedPlatform, calculator: PaddingCalculator, language: BindingLanguage): BindingOutput {
  const builder = new ModelBuilder(calculator, platform);
  const filename = `${result.struct.name}.${bindingLanguages[language].extension}`;
  try {
    const root = builder.record(result, result.struct.name);
    const records = builder.records; // dependencies first: each is pushed after what it contains
    const ctx: EmitContext = { platform, notes: builder.notes, bigEndian: platform.architecture.endianness === 'big', pointerSize: platform.architecture.pointerSize, root };
    const code = EMITTERS[language](records, ctx);
    return { code, filename, notes: [...new Set(ctx.notes)] };
  } catch (err) {
    if (!(err instanceof BindingError)) throw err;
    return { code: '', filename, notes: [], error: err.message };
  }
}

interface EmitContext {
  platform: ResolvedPlatform;
  notes: string[];
  bigEndian: boolean;
  pointerSize: number;
  root: Record_;
}

type Emitter = (records: Record_[], ctx: EmitContext) => string;

const platformLine = (ctx: EmitContext) =>
  `${ctx.platform.architecture.displayName}, ${ctx.platform.dataModel}, ${ctx.platform.os}${ctx.bigEndian ? ', big-endian' : ''}`;

// ------------------------------------------------------------------ Rust

const rustInt = (t: Extract<BType, { kind: 'int' }>) => `${t.signed ? 'i' : 'u'}${t.size * 8}`;

function rustType(t: BType, bytes: boolean, size: number): string {
  if (bytes) return `[u8; ${size}]`;
  switch (t.kind) {
    case 'int': return rustInt(t);
    case 'float': return `f${t.size * 8}`;
    case 'bool': return 'bool';
    case 'pointer': return t.function ? 'Option<unsafe extern "C" fn()>' : '*mut core::ffi::c_void';
    case 'record': return t.record.name;
    case 'bytes': return `[u8; ${t.size}]`;
    case 'array': return t.dims.reduceRight((inner, d) => `[${inner}; ${d}]`, rustType(t.element, false, 0));
  }
}

/** A type with no Rust equivalent, carried as a byte array: aligned to 1 in Rust. */
const carriedAsBytes = (t: BType): boolean => t.kind === 'bytes' || (t.kind === 'array' && carriedAsBytes(t.element));

const emitRust: Emitter = (records, ctx) => {
  const triple = rustTarget(ctx.platform);
  if (!triple) throw new BindingError(`Rust has no target for ${platformLine(ctx)}.`);
  const out = [`// ${ctx.root.cName} on ${platformLine(ctx)}.`, `// #[repr(C)] follows the target's C layout: compile it for ${triple}.`, ''];
  for (const r of records) {
    const pack = r.pack;
    const { placed, align } = placeNatural(r, (item) => {
      if (item.kind === 'bits' || carriedAsBytes(item.type)) return 1;
      return pack !== undefined ? Math.min(item.natural, pack) : item.natural;
    });
    const reprs = ['C'];
    if (pack !== undefined) reprs.push(`packed(${pack})`);
    if (r.align > Math.min(align, pack ?? Infinity)) {
      if (pack !== undefined) ctx.notes.push(`${r.cName} is packed and aligned to ${r.align}; Rust cannot say both, so it keeps packed(${pack}) and is aligned to ${Math.min(align, pack)}.`);
      else reprs.push(`align(${r.align})`);
    }
    out.push(`#[repr(${reprs.join(', ')})]`, '#[derive(Clone, Copy)]', `pub ${r.union ? 'union' : 'struct'} ${r.name} {`);
    for (const p of placed) {
      if ('pad' in p) out.push(`    pub ${p.name}: [u8; ${p.pad}],`);
      else if (p.item.kind === 'bits') out.push(`    /// ${bitsComment(p.item, ctx.bigEndian)}`, `    pub ${ident(p.item.name, 'rust')}: [u8; ${p.item.size}],`);
      else {
        if (p.bytes) ctx.notes.push(`'${p.item.name}' in ${r.cName} is at an offset Rust's alignment for it does not allow, so it is carried as ${p.item.size} bytes.`);
        out.push(`    pub ${ident(p.item.name, 'rust')}: ${rustType(p.item.type, p.bytes === true, p.item.size)}, // offset ${p.item.offset}`);
      }
    }
    if (r.union) {
      // A union's size can include padding of its own: a byte array of that size carries it.
      out.push(`    pub _size: [u8; ${r.size}],`);
    }
    out.push('}', '');
  }
  return out.join('\n');
};

// ------------------------------------------------------------------ Zig

function zigType(t: BType, bytes: boolean, size: number): string {
  if (bytes) return `[${size}]u8`;
  switch (t.kind) {
    case 'int': return `${t.signed ? 'i' : 'u'}${t.size * 8}`;
    case 'float': return `f${t.size * 8}`;
    case 'bool': return 'bool';
    case 'pointer': return t.function ? '?*const fn () callconv(.c) void' : '?*anyopaque';
    case 'record': return t.record.name;
    case 'bytes': return `[${t.size}]u8`;
    case 'array': return `${t.dims.map((d) => `[${d}]`).join('')}${zigType(t.element, false, 0)}`;
  }
}

const emitZig: Emitter = (records, ctx) => {
  const target = zigTarget(ctx.platform);
  if (!target) throw new BindingError(`Zig has no target for ${platformLine(ctx)}.`);
  const out = [`// ${ctx.root.cName} on ${platformLine(ctx)}.`, `// extern structs follow the target's C layout: build for -target ${target}.`, ''];
  for (const r of records) {
    // Each field gets the alignment C gives it in this struct, so a natural placement reproduces C.
    const { placed, align } = placeNatural(r, (item) => (item.kind === 'bits' ? 1 : item.align));
    out.push(`pub const ${r.name} = extern ${r.union ? 'union' : 'struct'} {`);
    let first = true;
    for (const p of placed) {
      // The struct's own alignment, where C's is more than its members', goes on the first field.
      const raise = first && r.align > align ? r.align : undefined;
      first = false;
      if ('pad' in p) out.push(`    ${p.name}: [${p.pad}]u8${raise ? ` align(${raise})` : ''},`);
      else if (p.item.kind === 'bits') out.push(`    /// ${bitsComment(p.item, ctx.bigEndian)}`, `    ${ident(p.item.name, 'zig')}: [${p.item.size}]u8${raise ? ` align(${raise})` : ''},`);
      else {
        // Always the alignment C gives it here, so no field depends on Zig's own for its type.
        const a = raise ?? (p.bytes ? 1 : p.item.align);
        out.push(`    ${ident(p.item.name, 'zig')}: ${zigType(p.item.type, p.bytes === true, p.item.size)} align(${a}), // offset ${p.item.offset}`);
      }
    }
    if (r.union) out.push(`    _size: [${r.size}]u8,`);
    out.push('};', '');
  }
  return out.join('\n');
};

// ------------------------------------------------------------------ Go

function goType(t: BType, bytes: boolean, size: number): string {
  if (bytes) return `[${size}]byte`;
  switch (t.kind) {
    case 'int': return `${t.signed ? 'int' : 'uint'}${t.size * 8}`;
    case 'float': return `float${t.size * 8}`;
    case 'bool': return 'bool';
    case 'pointer': return 'uintptr';
    case 'record': return t.record.name;
    case 'bytes': return `[${t.size}]byte`;
    case 'array': return `${t.dims.map((d) => `[${d}]`).join('')}${goType(t.element, false, 0)}`;
  }
}

const emitGo: Emitter = (records, ctx) => {
  const target = goTarget(ctx.platform);
  if (!target) throw new BindingError(`Go has no port for ${platformLine(ctx)}.`);
  const goAligns = new Map<Record_, number>();
  const goAlign = (t: BType): number => {
    switch (t.kind) {
      case 'int': case 'float': return Math.min(t.size, target.maxAlign);
      case 'pointer': return Math.min(t.size, target.maxAlign);
      case 'bool': case 'bytes': return 1;
      case 'record': return goAligns.get(t.record) ?? 1;
      case 'array': return goAlign(t.element);
    }
  };
  const out = [`// ${ctx.root.cName} on ${platformLine(ctx)}, for GOARCH=${target.arch}.`, '// Padding fields give each member its C offset; Go would not add the same padding itself.', '', 'package bindings', ''];
  for (const r of records) {
    if (r.union) {
      // Go has no unions: the union's bytes, with what it holds in a comment.
      out.push(`// ${r.cName}: a union of ${r.items.map((i) => i.name).join(', ')}.`, `type ${r.name} struct {`, `\tRaw [${r.size}]byte`, '}', '');
      ctx.notes.push(`Go has no unions: ${r.cName} is its ${r.size} bytes.`);
      goAligns.set(r, 1);
      continue;
    }
    const items = r.items.filter((i) => !(i.kind === 'field' && i.type.kind === 'array' && i.type.dims[0] === 0));
    if (items.length < r.items.length) ctx.notes.push(`Go puts padding after a zero-size last field, so ${r.cName}'s flexible array member is left out.`);
    const { placed, size, align } = placeNatural({ ...r, items }, (item) => (item.kind === 'bits' ? 1 : goAlign(item.type)));
    goAligns.set(r, align);
    if (size !== r.size) throw new BindingError(`Go would make ${r.cName} ${size} bytes, not ${r.size}: its alignment for a member differs from C's.`);
    if (align < r.align) ctx.notes.push(`Go aligns ${r.cName} to ${align}, C to ${r.align}: its size and member offsets are the same, but a variable of it may start at a different address.`);
    out.push(`type ${r.name} struct {`);
    for (const p of placed) {
      if ('pad' in p) out.push(`\t_ [${p.pad}]byte`);
      else if (p.item.kind === 'bits') out.push(`\t// ${bitsComment(p.item, ctx.bigEndian)}`, `\t${ident(p.item.name, 'go')} [${p.item.size}]byte`);
      else {
        if (p.bytes) ctx.notes.push(`'${p.item.name}' in ${r.cName} is at an offset Go's alignment for it does not allow, so it is carried as ${p.item.size} bytes.`);
        out.push(`\t${ident(p.item.name, 'go')} ${goType(p.item.type, p.bytes === true, p.item.size)} // offset ${p.item.offset}`);
      }
    }
    out.push('}', '');
  }
  return out.join('\n');
};

// ------------------------------------------------------------------ C#

function csScalar(t: BType): string | undefined {
  switch (t.kind) {
    case 'int': return { 1: t.signed ? 'sbyte' : 'byte', 2: t.signed ? 'short' : 'ushort', 4: t.signed ? 'int' : 'uint', 8: t.signed ? 'long' : 'ulong' }[t.size];
    case 'float': return t.size === 4 ? 'float' : 'double';
    // bool is not blittable in .NET (it marshals as 4 bytes): C's 1-byte _Bool is a byte.
    case 'bool': return 'byte';
    case 'pointer': return { 2: 'ushort', 4: 'uint', 8: 'ulong' }[t.size];
    default: return undefined;
  }
}

const emitCSharp: Emitter = (records, ctx) => {
  const out = [`// ${ctx.root.cName} on ${platformLine(ctx)}.`, '// Every field has its C offset: the same on any machine. Pointers are integers of the target\'s pointer size.', '// Compile with AllowUnsafeBlocks (fixed-size buffers).', '', 'using System.Runtime.InteropServices;', ''];
  for (const r of records) {
    out.push(`[StructLayout(LayoutKind.Explicit, Size = ${r.size})]`, `public unsafe struct ${r.name}`, '{');
    for (const item of r.items) {
      const at = `[FieldOffset(${item.offset})]`;
      if (item.kind === 'bits') {
        out.push(`    // ${bitsComment(item, ctx.bigEndian)}`, `    ${at} public fixed byte ${ident(item.name, 'csharp')}[${item.size}];`);
        continue;
      }
      const t = item.type;
      // A C# member may not have its type's name.
      const name = item.name === r.name ? `${item.name}_` : ident(item.name, 'csharp');
      if (t.kind === 'array') {
        const count = t.dims.reduce((a, b) => a * b, 1);
        if (count === 0) {
          ctx.notes.push(`C# has no flexible array members: ${r.cName}'s '${item.name}' is left out.`);
          continue;
        }
        const scalar = csScalar(t.element);
        if (scalar) {
          out.push(`    ${at} public fixed ${scalar} ${name}[${count}];${t.dims.length > 1 ? ` // [${t.dims.join('][')}]` : ''}`);
        } else if (t.element.kind === 'bytes') {
          out.push(`    ${at} public fixed byte ${name}[${count * t.element.size}];`);
        } else {
          // A fixed buffer holds only primitives: one field per element.
          const element = t.element.kind === 'record' ? t.element.record : undefined;
          const step = item.size / count;
          for (let k = 0; k < count; k++) out.push(`    [FieldOffset(${item.offset + k * step})] public ${element!.name} ${item.name}_${k};`);
        }
        continue;
      }
      const scalar = csScalar(t);
      if (scalar) out.push(`    ${at} public ${scalar} ${name};${t.kind === 'pointer' ? ' // pointer' : t.kind === 'bool' ? ' // _Bool' : ''}`);
      else if (t.kind === 'record') out.push(`    ${at} public ${t.record.name} ${name};`);
      else out.push(`    ${at} public fixed byte ${name}[${item.size}];`);
    }
    out.push('}', '');
  }
  return out.join('\n');
};

// ------------------------------------------------------------------ Python struct

/** One struct format code per value, in standard sizes ('<' or '>'), and the names it fills. */
function structCodes(t: BType, name: string, size: number): Array<{ code: string; names: string[] }> {
  const int = (s: number, signed: boolean) => ({ 1: 'b', 2: 'h', 4: 'i', 8: 'q' } as Record<number, string>)[s]?.[signed ? 'toLowerCase' : 'toUpperCase']();
  switch (t.kind) {
    case 'int': {
      const code = int(t.size, t.signed);
      return [{ code: code ?? `${t.size}s`, names: [name] }];
    }
    case 'float': return [{ code: t.size === 4 ? 'f' : 'd', names: [name] }];
    case 'bool': return [{ code: '?', names: [name] }];
    case 'pointer': return [{ code: int(t.size, false) ?? `${t.size}s`, names: [name] }];
    case 'bytes': return [{ code: `${t.size}s`, names: [name] }];
    case 'record': return flattenStruct(t.record, `${name}.`);
    case 'array': {
      const count = t.dims.reduce((a, b) => a * b, 1);
      const element = t.element;
      // A char array is one bytes value.
      if (element.kind === 'int' && element.size === 1) return [{ code: `${count}s`, names: [name] }];
      const step = count > 0 ? size / count : 0;
      return Array.from({ length: count }, (_, k) => structCodes(element, `${name}[${k}]`, step)).flat();
    }
  }
}

function flattenStruct(r: Record_, prefix: string): Array<{ code: string; names: string[] }> {
  if (r.union) return [{ code: `${r.size}s`, names: [`${prefix.replace(/\.$/, '')}`] }];
  const codes: Array<{ code: string; names: string[] }> = [];
  let pos = 0;
  for (const item of r.items) {
    // A flexible array member has no bytes of its own to read.
    if (item.kind === 'field' && item.type.kind === 'array' && item.type.dims[0] === 0) continue;
    if (item.offset > pos) codes.push({ code: `${item.offset - pos}x`, names: [] });
    if (item.kind === 'bits') codes.push({ code: `${item.size}s`, names: [`${prefix}${item.name}`] });
    else codes.push(...structCodes(item.type, `${prefix}${item.name}`, item.size));
    pos = Math.max(pos, item.offset + item.size);
  }
  if (r.size > pos) codes.push({ code: `${r.size - pos}x`, names: [] });
  return codes;
}

const emitPythonStruct: Emitter = (records, ctx) => {
  const r = ctx.root;
  const codes = flattenStruct(r, '');
  const order = ctx.bigEndian ? '>' : '<';
  const constant = r.name.toUpperCase();
  for (const rec of records) if (rec.union) ctx.notes.push(`struct has no unions: ${rec.cName} is read as its ${rec.size} bytes.`);
  for (const rec of records) for (const item of rec.items) if (item.kind === 'bits') ctx.notes.push(`Bit-fields are read as the bytes they share: ${bitsComment(item, ctx.bigEndian)}.`);
  const names = codes.flatMap((c) => c.names);
  return [
    `# ${r.cName} on ${platformLine(ctx)}: ${r.size} bytes.`,
    `# Standard sizes in the target's byte order ('${order}'), with C's padding as pad bytes (x).`,
    'import struct',
    '',
    `${constant}_FORMAT = '${order}${codes.map((c) => c.code).join('')}'`,
    `${constant}_FIELDS = (${names.map((n) => `'${n}'`).join(', ')}${names.length === 1 ? ',' : ''})`,
    `${constant} = struct.Struct(${constant}_FORMAT)`,
    `assert ${constant}.size == ${r.size}`,
    '',
    '',
    `def unpack_${r.name.toLowerCase()}(buffer, offset=0):`,
    `    """The members of one ${r.cName} at \`offset\` in \`buffer\`, by name."""`,
    `    return dict(zip(${constant}_FIELDS, ${constant}.unpack_from(buffer, offset)))`,
    '',
  ].join('\n');
};

// ------------------------------------------------------------------ Python ctypes

function ctypesType(t: BType, bigEndian: boolean): string {
  switch (t.kind) {
    case 'int': return `ctypes.c_${t.signed ? 'int' : 'uint'}${t.size * 8}`;
    case 'float': return t.size === 4 ? 'ctypes.c_float' : 'ctypes.c_double';
    // ctypes refuses c_bool in a big-endian structure; one byte has no byte order anyway.
    case 'bool': return bigEndian ? 'ctypes.c_uint8' : 'ctypes.c_bool';
    // c_void_p has the size of the machine running Python; the target's pointer is an integer.
    case 'pointer': return `ctypes.c_uint${t.size * 8}`;
    case 'record': return t.record.name;
    case 'bytes': return `ctypes.c_uint8 * ${t.size}`;
    case 'array': return t.dims.reduceRight((inner, d) => `(${inner}) * ${d}`, ctypesType(t.element, bigEndian));
  }
}

const emitPythonCtypes: Emitter = (records, ctx) => {
  const endian = ctx.bigEndian ? 'BigEndian' : 'LittleEndian';
  const out = [
    `# ${ctx.root.cName} on ${platformLine(ctx)}.`,
    '# Packed, with C\'s padding written out: the layout is the same on any machine. In the',
    '# target\'s byte order, and with pointers as integers of its pointer size.',
    'import ctypes',
    '',
  ];
  for (const r of records) {
    const { placed } = placeNatural(r, () => 1);
    out.push('', `class ${r.name}(ctypes.${endian}${r.union ? 'Union' : 'Structure'}):`, '    _pack_ = 1', "    _layout_ = 'ms'", '    _fields_ = [');
    for (const p of placed) {
      if ('pad' in p) out.push(`        ('${p.name}', ctypes.c_uint8 * ${p.pad}),`);
      else if (p.item.kind === 'bits') out.push(`        # ${bitsComment(p.item, ctx.bigEndian)}`, `        ('${p.item.name}', ctypes.c_uint8 * ${p.item.size}),`);
      else out.push(`        ('${p.item.name}', ${ctypesType(p.item.type, ctx.bigEndian)}),  # offset ${p.item.offset}`);
    }
    if (r.union) out.push(`        ('_size', ctypes.c_uint8 * ${r.size}),`);
    out.push('    ]', '', '', `assert ctypes.sizeof(${r.name}) == ${r.size}`);
  }
  out.push('');
  return out.join('\n');
};

const EMITTERS: Record<BindingLanguage, Emitter> = {
  rust: emitRust,
  zig: emitZig,
  go: emitGo,
  csharp: emitCSharp,
  'python-struct': emitPythonStruct,
  'python-ctypes': emitPythonCtypes,
};
