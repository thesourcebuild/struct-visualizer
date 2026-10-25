import type { CalculationResult, StructMember } from '../types';
import type { ResolvedPlatform } from '../abi/resolve-selection';
import type { PaddingCalculator } from '../layout/padding-calculator';
import { alignColumns } from '../go/codegen';

/**
 * Bindings: the laid-out C struct written in another language so that it has exactly the same
 * size and member offsets on the selected target. Each language places fields by its own rules,
 * so each emitter is told how its language places them and adds what the C layout needs on top:
 * explicit padding, an alignment, or explicit offsets. Every binding is compiled and its offsets
 * checked against the C layout in tests/bindings.test.ts.
 */
export type BindingLanguage = 'rust' | 'zig' | 'go' | 'csharp' | 'python-struct' | 'python-ctypes';

export const bindingLanguages: Record<BindingLanguage, { label: string; extension: string; summary: string }> = {
  rust: { label: 'Rust', extension: 'rs', summary: '#[repr(C)] structs and unions for the target triple named in the file, which checks its layout when compiled, with from_bytes and a test.' },
  zig: { label: 'Zig', extension: 'zig', summary: 'extern structs and unions, with field alignments where C has its own; the file checks its layout when compiled, and has a test.' },
  go: { label: 'Go', extension: 'go', summary: 'Structs with every padding byte a field, for the GOARCH named in the file, which checks its layout when compiled; read and written with encoding/binary, with an example test.' },
  csharp: { label: 'C#', extension: 'cs', summary: '[StructLayout(LayoutKind.Explicit)] with every field at its offset: the same on any machine. FromBytes and ToBytes, with a round-trip example.' },
  'python-struct': { label: 'Python struct', extension: 'py', summary: 'struct format strings in the target byte order with explicit pad bytes, to read and write raw data, with a round trip when run.' },
  'python-ctypes': { label: 'Python ctypes', extension: 'py', summary: 'ctypes Structures in the target byte order, packed with explicit padding: the same on any machine. Checked on import, with a round trip when run.' },
};

export interface BindingFile {
  filename: string;
  code: string;
}

export interface BindingOutput {
  /**
   * The binding: the types, a check of their layout where the language can make one (at compile
   * time in Rust, Zig and Go, on import in Python), a way to read and write them as raw bytes, and
   * a round-trip example where the language keeps examples with the code (Rust and Zig tests,
   * Python's `__main__`).
   */
  code: string;
  filename: string;
  /** The example, where the language keeps it in a file of its own (Go's `_test.go`, C#). */
  example?: BindingFile;
  /** How to use it, step by step: build it, read and write the bytes, run the example. */
  usage: string[];
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
 * later than C did (C packed it) is carried as bytes. With `explicit`, every gap is a padding
 * field, the trailing one too. Returns the placement and the language's own size and alignment
 * for the record without an alignment attribute.
 */
function placeNatural(record: Record_, align: (item: Item) => number, explicit = false): { placed: Placed; size: number; align: number } {
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
    if (item.offset % a !== 0) {
      // The language cannot put it where C does: carry its bytes, which align to 1.
      bytes = true;
      a = 1;
    }
    // Padding where the language would not reach C's offset by aligning the field itself, or
    // every gap when the language must see each padding byte (Go's encoding/binary).
    if (explicit ? pos < item.offset : alignTo(pos, a) < item.offset) {
      placed.push({ pad: item.offset - pos, name: `_pad${pads++}` });
    }
    placed.push(bytes ? { item, bytes } : { item });
    maxAlign = Math.max(maxAlign, a);
    pos = item.offset + item.size;
  }
  if (explicit ? pos < record.size : alignTo(pos, maxAlign) < record.size) {
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

// ------------------------------------------------------------------ examples

/** A step from a record to one of its values: a member, an array element, or a union's bytes. */
type Step =
  | { kind: 'field'; record: Record_; item: Item }
  | { kind: 'index'; index: number[]; flat: number; type: Extract<BType, { kind: 'array' }> }
  | { kind: 'raw'; record: Record_ };

type LeafType = Extract<BType, { kind: 'int' | 'float' | 'bool' | 'pointer' | 'bytes' }>;

/** One value an example sets: where it is, its type, and the value. */
interface Leaf {
  path: Step[];
  offset: number;
  type: LeafType;
  /** A number, true for a bool, or bytes. Function pointers are null (0): no function is there. */
  value: number | boolean | number[];
  /** Reached through a union member, which some languages must say (Rust's unsafe). */
  inUnion: boolean;
}

interface LeafOptions {
  /** Items the language carries as their bytes: placed where their alignment does not allow. */
  asBytes?: ReadonlySet<Item>;
  /** Unions the language carries as their bytes (Go). */
  unionsAsBytes?: boolean;
}

/** The example's value for the k-th value: small enough for any integer, exact as a float. */
function sampleValue(t: LeafType, k: number): Leaf['value'] {
  const small = ((k - 1) % 100) + 1;
  switch (t.kind) {
    case 'int': return small;
    case 'float': return k + 0.5;
    case 'bool': return true;
    case 'pointer': return t.function ? 0 : 16 * small;
    case 'bytes': return Array.from({ length: t.size }, (_, j) => (k + j) % 256);
  }
}

/**
 * Bytes an example writes out in full, up to this many; more (a union carried as its bytes, a
 * char array in Python's struct) are made by a loop from the first, as sampleValue makes them.
 */
const LITERAL_BYTES = 16;

/**
 * The values an example sets in `root`: every scalar, the first and last element of each array,
 * and a union's first member (a union holds one at a time). Flexible array members hold none.
 */
function leaves(root: Record_, options: LeafOptions = {}): Leaf[] {
  const out: Leaf[] = [];
  const push = (path: Step[], offset: number, type: LeafType, inUnion: boolean) => out.push({ path, offset, type, value: sampleValue(type, out.length + 1), inUnion });
  const walkRecord = (r: Record_, base: number, path: Step[], inUnion: boolean) => {
    if (r.union && options.unionsAsBytes) {
      push([...path, { kind: 'raw', record: r }], base, { kind: 'bytes', size: r.size }, inUnion);
      return;
    }
    for (const item of r.union ? r.items.slice(0, 1) : r.items) {
      const at: Step[] = [...path, { kind: 'field', record: r, item }];
      if (item.kind === 'bits' || options.asBytes?.has(item)) push(at, base + item.offset, { kind: 'bytes', size: item.size }, inUnion || r.union);
      else walkType(item.type, base + item.offset, item.size, at, inUnion || r.union);
    }
  };
  const walkType = (t: BType, offset: number, size: number, path: Step[], inUnion: boolean) => {
    switch (t.kind) {
      case 'record':
        walkRecord(t.record, offset, path, inUnion);
        return;
      case 'array': {
        const count = t.dims.reduce((a, b) => a * b, 1);
        if (count === 0) return;
        const step = size / count;
        for (const flat of count === 1 ? [0] : [0, count - 1]) {
          const index = t.dims.map((_, d) => Math.floor(flat / t.dims.slice(d + 1).reduce((a, b) => a * b, 1)) % t.dims[d]!);
          walkType(t.element, offset + flat * step, step, [...path, { kind: 'index', index, flat, type: t }], inUnion);
        }
        return;
      }
      default:
        push(path, offset, t, inUnion);
    }
  };
  walkRecord(root, 0, [], false);
  return out;
}

/** The offset of every bool outside a union, whose bytes must be 0 or 1 (unions take any bytes). */
function boolOffsets(r: Record_, base = 0): number[] {
  if (r.union) return [];
  const ofType = (t: BType, offset: number, size: number): number[] => {
    if (t.kind === 'bool') return [offset];
    if (t.kind === 'record') return boolOffsets(t.record, offset);
    if (t.kind !== 'array') return [];
    const count = t.dims.reduce((a, b) => a * b, 1);
    return Array.from({ length: count }, (_, k) => ofType(t.element, offset + (k * size) / count, size / count)).flat();
  };
  return r.items.flatMap((item) => (item.kind === 'field' ? ofType(item.type, base + item.offset, item.size) : []));
}

/** A name not yet taken, made so by trailing underscores; it is then taken. */
function unique(name: string, taken: Set<string>): string {
  let n = name;
  while (taken.has(n)) n += '_';
  taken.add(n);
  return n;
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
    const { code, example, usage } = EMITTERS[language](records, ctx);
    return { code, filename, ...(example && { example }), usage, notes: [...new Set(ctx.notes)] };
  } catch (err) {
    if (!(err instanceof BindingError)) throw err;
    return { code: '', filename, usage: [], notes: [], error: err.message };
  }
}

interface EmitContext {
  platform: ResolvedPlatform;
  notes: string[];
  bigEndian: boolean;
  pointerSize: number;
  root: Record_;
}

type Emitter = (records: Record_[], ctx: EmitContext) => { code: string; example?: BindingFile; usage: string[] };

/** The target, as the files name it; the architecture's name says when it is big-endian. */
const platformLine = (ctx: EmitContext) => `${ctx.platform.architecture.displayName}, ${ctx.platform.dataModel}, ${ctx.platform.os}`;

const byteOrder = (ctx: EmitContext) => (ctx.bigEndian ? 'big-endian' : 'little-endian');

/** Numbers as a comma-separated list, for the literals of byte arrays. */
const list = (values: number[]) => values.join(', ');

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

/** The Rust (or Zig, Go) expression for a value under `base`: its fields and indices. */
function valuePath(base: string, path: Step[], name: (s: Extract<Step, { kind: 'field' }>) => string): string {
  return base + path.map((s) => (s.kind === 'field' ? `.${name(s)}` : s.kind === 'index' ? s.index.map((i) => `[${i}]`).join('') : '.Raw')).join('');
}

const emitRust: Emitter = (records, ctx) => {
  const triple = rustTarget(ctx.platform);
  if (!triple) throw new BindingError(`Rust has no target for ${platformLine(ctx)}.`);
  const root = ctx.root;
  const out = [
    `// ${root.cName} on ${platformLine(ctx)}.`,
    `// #[repr(C)] follows the target's C layout: compile it for ${triple}, where the layout is checked.`,
    `// ${root.name}::from_bytes reads one from the bytes the target stores.`,
    '',
  ];
  const carried = new Set<Item>();
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
        if (p.bytes) {
          carried.add(p.item);
          ctx.notes.push(`'${p.item.name}' in ${r.cName} is at an offset Rust's alignment for it does not allow, so it is carried as ${p.item.size} bytes.`);
        }
        out.push(`    pub ${ident(p.item.name, 'rust')}: ${rustType(p.item.type, p.bytes === true, p.item.size)}, // offset ${p.item.offset}`);
      }
    }
    if (r.union) {
      // A union's size can include padding of its own: a byte array of that size carries it.
      out.push(`    pub _size: [u8; ${r.size}],`);
    }
    out.push('}', '');
  }

  out.push('// The layout, checked when this file is compiled: built for another target, it fails here.', 'const _: () = {');
  for (const r of records) {
    out.push(`    assert!(core::mem::size_of::<${r.name}>() == ${r.size});`);
    for (const item of r.items) out.push(`    assert!(core::mem::offset_of!(${r.name}, ${ident(item.name, 'rust')}) == ${item.offset});`);
  }
  out.push('};', '');

  // read_unaligned is sound only for bytes that are a valid value of every field: any are, but a
  // bool's, which must be 0 or 1 (a union's fields hold any bytes).
  const bools = boolOffsets(root);
  out.push(`impl ${root.name} {`);
  if (bools.length > 0) {
    out.push(
      `    /// One ${root.name} from the bytes the target stores for it, or None where a bool is neither 0 nor 1.`,
      `    pub fn from_bytes(bytes: &[u8; ${root.size}]) -> Option<Self> {`,
      `        const BOOLS: [usize; ${bools.length}] = [${list(bools)}];`,
      '        if BOOLS.iter().any(|&i| bytes[i] > 1) {',
      '            return None;',
      '        }',
      `        // SAFETY: the array is as large as ${root.name}, its bools are 0 or 1, and any bytes are a value of its other fields.`,
      '        Some(unsafe { core::ptr::read_unaligned(bytes.as_ptr().cast()) })',
    );
  } else {
    out.push(
      `    /// One ${root.name} from the bytes the target stores for it.`,
      `    pub fn from_bytes(bytes: &[u8; ${root.size}]) -> Self {`,
      `        // SAFETY: the array is as large as ${root.name}, and any bytes are a value of each of its fields.`,
      '        unsafe { core::ptr::read_unaligned(bytes.as_ptr().cast()) }',
    );
  }
  out.push('    }', '}', '');

  const values = leaves(root, { asBytes: carried });
  const suffix = ctx.bigEndian ? 'be' : 'le';
  const writes: string[] = [];
  const checks: string[] = [];
  for (const l of values) {
    const range = `bytes[${l.offset}..${l.offset + (l.type.kind === 'bool' ? 1 : l.type.size)}]`;
    const read = l.inUnion ? `unsafe { ${valuePath('value', l.path, (s) => ident(s.item.name, 'rust'))} }` : `{ ${valuePath('value', l.path, (s) => ident(s.item.name, 'rust'))} }`;
    switch (l.type.kind) {
      case 'int':
        writes.push(`${range}.copy_from_slice(&${l.value}${rustInt(l.type)}.to_${suffix}_bytes());`);
        checks.push(`assert_eq!(${read}, ${l.value});`);
        break;
      case 'float':
        writes.push(`${range}.copy_from_slice(&${l.value}f${l.type.size * 8}.to_${suffix}_bytes());`);
        checks.push(`assert_eq!(${read}, ${l.value});`);
        break;
      case 'bool':
        writes.push(`bytes[${l.offset}] = 1;`);
        checks.push(`assert!(${read});`);
        break;
      case 'pointer':
        if (l.type.function) checks.push(`assert!(${read}.is_none());`);
        else {
          writes.push(`${range}.copy_from_slice(&${l.value}u${l.type.size * 8}.to_${suffix}_bytes());`);
          checks.push(`assert_eq!(${read} as usize, ${l.value});`);
        }
        break;
      case 'bytes': {
        const v = l.value as number[];
        if (v.length <= LITERAL_BYTES) {
          writes.push(`${range}.copy_from_slice(&[${list(v)}]);`);
          checks.push(`assert_eq!(${read}, [${list(v)}]);`);
        } else {
          writes.push(`for (j, byte) in ${range}.iter_mut().enumerate() {`, `    *byte = (${v[0]} + j) as u8;`, '}');
          checks.push(`assert!(${read}.iter().enumerate().all(|(j, &byte)| byte == (${v[0]} + j) as u8));`);
        }
        break;
      }
    }
  }
  // The round trip runs as a program (main, which prints with std; in a crate it is a function
  // of the module) and as a test. Both need std and a machine to run on: bare metal has neither.
  const hosted = ctx.platform.os !== 'none';
  if (hosted) {
    out.push(
      `/// ${root.cName} from the bytes the target stores: each value at its offset, ${byteOrder(ctx)}, read back.`,
      'fn round_trip() {',
      `    let ${writes.length > 0 ? 'mut ' : ''}bytes = [0u8; ${root.size}];`,
      ...writes.map((w) => `    ${w}`),
      `    let value = ${root.name}::from_bytes(&bytes)${bools.length > 0 ? '.unwrap()' : ''};`,
      ...checks.map((c) => `    ${c}`),
      '}',
      '',
      '/// Run as a program (rustc, or cargo run), the round trip, saying what it read.',
      'pub fn main() {',
      '    round_trip();',
      `    println!("${root.name}: each field read back from its ${root.size} bytes");`,
      '}',
      '',
      '#[cfg(test)]',
      `mod ${unique('tests', new Set(records.map((r) => r.name)))} {`,
      '    #[test]',
      '    fn from_bytes_reads_each_field() {',
      '        super::round_trip();',
      '    }',
      '}',
      '',
    );
  }
  const file = `${root.name}.rs`;
  return {
    code: out.join('\n'),
    usage: [
      `Add ${file} to a crate built for ${triple}: compiling it checks the layout, and fails for another target.`,
      `${root.name}::from_bytes(&bytes) reads one from the bytes the target stores.`,
      ...(hosted ? [`On a ${triple} machine, rustc ${file} builds it as a program that runs its round trip (and cargo test runs it as a test).`] : []),
    ],
  };
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
  const root = ctx.root;
  const out = [
    `// ${root.cName} on ${platformLine(ctx)}.`,
    `// extern structs follow the target's C layout: build for -target ${target}, where the layout is checked.`,
    `// std.mem.bytesToValue(${root.name}, &bytes) reads one from the bytes the target stores; std.mem.toBytes(value) gives them.`,
    '',
  ];
  const carried = new Set<Item>();
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
        if (p.bytes) carried.add(p.item);
        // Always the alignment C gives it here, so no field depends on Zig's own for its type.
        const a = raise ?? (p.bytes ? 1 : p.item.align);
        out.push(`    ${ident(p.item.name, 'zig')}: ${zigType(p.item.type, p.bytes === true, p.item.size)} align(${a}), // offset ${p.item.offset}`);
      }
    }
    if (r.union) out.push(`    _size: [${r.size}]u8,`);
    out.push('};', '');
  }

  out.push('// The layout, checked when this file is compiled: built for another target, it fails here.', 'comptime {');
  for (const r of records) {
    out.push(`    if (@sizeOf(${r.name}) != ${r.size}) @compileError("${r.name} is not ${r.size} bytes on this target");`);
    // @offsetOf takes a struct; a union's members are all at 0.
    if (!r.union) for (const item of r.items) out.push(`    if (@offsetOf(${r.name}, "${item.name}") != ${item.offset}) @compileError("${r.name}.${item.name} is not at offset ${item.offset} on this target");`);
  }
  out.push('}', '');

  // The test's locals may not shadow a declaration of the file: Zig forbids it.
  const taken = new Set(records.map((r) => r.name));
  const std = unique('std', taken);
  const bytes = unique('bytes', taken);
  const value = unique('value', taken);
  const byte = unique('byte', taken);
  const j = unique('j', taken);
  const endian = ctx.bigEndian ? '.big' : '.little';
  const writes: string[] = [];
  const checks: string[] = [];
  for (const l of leaves(root, { asBytes: carried })) {
    const range = `${bytes}[${l.offset}..${l.offset + (l.type.kind === 'bool' ? 1 : l.type.size)}]`;
    const read = valuePath(value, l.path, (s) => ident(s.item.name, 'zig'));
    switch (l.type.kind) {
      case 'int': {
        const t = `${l.type.signed ? 'i' : 'u'}${l.type.size * 8}`;
        writes.push(`${std}.mem.writeInt(${t}, ${range}, ${l.value}, ${endian});`);
        checks.push(`try ${std}.testing.expectEqual(@as(${t}, ${l.value}), ${read});`);
        break;
      }
      case 'float': {
        const bits = l.type.size * 8;
        writes.push(`${std}.mem.writeInt(u${bits}, ${range}, @bitCast(@as(f${bits}, ${l.value})), ${endian});`);
        checks.push(`try ${std}.testing.expectEqual(@as(f${bits}, ${l.value}), ${read});`);
        break;
      }
      case 'bool':
        writes.push(`${bytes}[${l.offset}] = 1;`);
        checks.push(`try ${std}.testing.expect(${read});`);
        break;
      case 'pointer':
        if (l.type.function) checks.push(`try ${std}.testing.expect(${read} == null);`);
        else {
          writes.push(`${std}.mem.writeInt(u${l.type.size * 8}, ${range}, ${l.value}, ${endian});`);
          checks.push(`try ${std}.testing.expectEqual(@as(usize, ${l.value}), @intFromPtr(${read}));`);
        }
        break;
      case 'bytes': {
        const v = l.value as number[];
        if (v.length <= LITERAL_BYTES) {
          writes.push(`@memcpy(${range}, &[_]u8{ ${list(v)} });`);
          checks.push(`try ${std}.testing.expectEqualSlices(u8, &[_]u8{ ${list(v)} }, &${read});`);
        } else {
          writes.push(`for (${range}, 0..) |*${byte}, ${j}| ${byte}.* = @truncate(${v[0]} + ${j});`);
          checks.push(`for (${read}, 0..) |${byte}, ${j}| try ${std}.testing.expectEqual(@as(u8, @truncate(${v[0]} + ${j})), ${byte});`);
        }
        break;
      }
    }
  }
  // The round trip runs as a program (main: only the root file's counts, so the file still
  // imports as a module) and as a test. Both need an OS (std writes through it): a bare-metal
  // target has neither. main must have its name; a type of the C source may have taken it.
  const hosted = ctx.platform.os !== 'none';
  const roundTrip = unique('roundTrip', taken);
  const runnable = hosted && !taken.has('main');
  if (hosted) {
    out.push(
      `test "${root.name} from the bytes the target stores" {`,
      `    try ${roundTrip}();`,
      '}',
      '',
    );
    if (runnable) {
      out.push(
        '/// Run as a program (zig run), the round trip, saying what it read.',
        'pub fn main() !void {',
        `    try ${roundTrip}();`,
        `    @import("std").debug.print("${root.name}: each field read back from its ${root.size} bytes\\n", .{});`,
        '}',
        '',
      );
    } else ctx.notes.push(`A type is named main, which a Zig program's entry point must be: the round trip runs with zig test only.`);
    out.push(
      `/// ${root.cName} from the bytes the target stores: each value at its offset, ${byteOrder(ctx)}, read back.`,
      `fn ${roundTrip}() !void {`,
      `    const ${std} = @import("std");`,
      `    ${writes.length > 0 ? 'var' : 'const'} ${bytes} = [_]u8{0} ** ${root.size};`,
      ...writes.map((w) => `    ${w}`),
      `    const ${value} = ${std}.mem.bytesToValue(${root.name}, &${bytes});`,
      ...checks.map((c) => `    ${c}`),
      '}',
      '',
    );
  }
  const machine = target.split(' ')[0];
  return {
    code: out.join('\n'),
    usage: [
      `Build ${root.name}.zig with -target ${target}: compiling it checks the layout, and fails for another target.`,
      `std.mem.bytesToValue(${root.name}, &bytes) reads one from the bytes the target stores; std.mem.toBytes(value) gives them.`,
      ...(runnable ? [`On a ${machine} machine, zig run ${root.name}.zig runs its round trip (and zig test ${root.name}.zig as a test).`] : []),
      ...(hosted && !runnable ? [`On a ${machine} machine, zig test ${root.name}.zig runs its round trip.`] : []),
    ],
  };
};

// ------------------------------------------------------------------ Go

/** A C name exported in Go, as encoding/binary needs: an upper-case first letter, or an X before a name that starts with none. */
export function goExportedName(name: string): string {
  if (/^[a-z]/.test(name)) return name[0]!.toUpperCase() + name.slice(1);
  return /^[A-Z]/.test(name) ? name : `X${name}`;
}

const emitGo: Emitter = (records, ctx) => {
  const target = goTarget(ctx.platform);
  if (!target) throw new BindingError(`Go has no port for ${platformLine(ctx)}.`);
  const root = ctx.root;
  const taken = new Set<string>();
  const typeName = new Map(records.map((r) => [r, unique(goExportedName(r.name), taken)] as const));
  const read = unique(`Read${typeName.get(root)}`, taken);
  const write = unique(`Write${typeName.get(root)}`, taken);
  const fieldName = new Map<Item, string>();
  const goType = (t: BType, bytes: boolean, size: number): string => {
    if (bytes) return `[${size}]byte`;
    switch (t.kind) {
      case 'int': return `${t.signed ? 'int' : 'uint'}${t.size * 8}`;
      case 'float': return `float${t.size * 8}`;
      case 'bool': return 'bool';
      // An integer of the target's pointer size: encoding/binary takes fixed sizes only.
      case 'pointer': return `uint${t.size * 8}`;
      case 'record': return typeName.get(t.record)!;
      case 'bytes': return `[${t.size}]byte`;
      case 'array': return `${t.dims.map((d) => `[${d}]`).join('')}${goType(t.element, false, 0)}`;
    }
  };
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
  const order = ctx.bigEndian ? 'binary.BigEndian' : 'binary.LittleEndian';
  const out = [
    `// ${root.cName} on ${platformLine(ctx)}, for GOARCH=${target.arch}.`,
    `// Every padding byte is a field, so the layout is the same in memory and in encoding/binary:`,
    `// ${read} and ${write} read and write one as the target stores it.`,
    '',
    'package bindings',
    '',
    'import (',
    '\t"encoding/binary"',
    '\t"io"',
    '\t"unsafe"',
    ')',
    '',
  ];
  const carried = new Set<Item>();
  for (const r of records) {
    const name = typeName.get(r)!;
    if (r.union) {
      // Go has no unions: the union's bytes, with what it holds in a comment.
      out.push(`// ${name} is ${r.cName}, a union of ${r.items.map((i) => i.name).join(', ')}.`, `type ${name} struct {`, `\tRaw [${r.size}]byte`, '}', '');
      ctx.notes.push(`Go has no unions: ${r.cName} is its ${r.size} bytes.`);
      goAligns.set(r, 1);
      continue;
    }
    const items = r.items.filter((i) => !(i.kind === 'field' && i.type.kind === 'array' && i.type.dims[0] === 0));
    if (items.length < r.items.length) ctx.notes.push(`Go puts padding after a zero-size last field, so ${r.cName}'s flexible array member is left out.`);
    const { placed, size, align } = placeNatural({ ...r, items }, (item) => (item.kind === 'bits' ? 1 : goAlign(item.type)), true);
    goAligns.set(r, align);
    if (size !== r.size) throw new BindingError(`Go would make ${r.cName} ${size} bytes, not ${r.size}: its alignment for a member differs from C's.`);
    if (align < r.align) ctx.notes.push(`Go aligns ${r.cName} to ${align}, C to ${r.align}: its size and member offsets are the same, but a variable of it may start at a different address.`);
    const fields = new Set<string>();
    // Cells of each line, aligned as gofmt aligns them; a comment on a line of its own is one cell.
    const rows: string[][] = [];
    for (const p of placed) {
      if ('pad' in p) {
        rows.push(['_', `[${p.pad}]byte`]);
        continue;
      }
      const field = unique(goExportedName(p.item.name), fields);
      fieldName.set(p.item, field);
      const comment = `// ${field === p.item.name ? '' : `${p.item.name}, `}offset ${p.item.offset}`;
      if (p.item.kind === 'bits') rows.push([`// ${bitsComment(p.item, ctx.bigEndian)}`], [field, `[${p.item.size}]byte`, comment]);
      else {
        if (p.bytes) {
          carried.add(p.item);
          ctx.notes.push(`'${p.item.name}' in ${r.cName} is at an offset Go's alignment for it does not allow, so it is carried as ${p.item.size} bytes.`);
        }
        rows.push([field, goType(p.item.type, p.bytes === true, p.item.size), comment]);
      }
    }
    out.push(`// ${name} is ${r.cName}.`, `type ${name} struct {`, ...alignColumns(rows).map((l) => `\t${l}`), '}', '');
  }

  out.push(`// The layout, checked when this file is compiled for GOARCH=${target.arch}: for another, it fails here.`);
  for (const r of records) {
    const name = typeName.get(r)!;
    out.push(`var _ = [1]struct{}{}[unsafe.Sizeof(${name}{})-${r.size}]`);
    for (const item of r.items) {
      const field = fieldName.get(item);
      if (field) out.push(`var _ = [1]struct{}{}[unsafe.Offsetof(${name}{}.${field})-${item.offset}]`);
    }
  }
  const rootType = typeName.get(root)!;
  out.push(
    '',
    `// ${read} reads one ${rootType} from r, as the target stores it (${byteOrder(ctx)}).`,
    `func ${read}(r io.Reader) (${rootType}, error) {`,
    `\tvar v ${rootType}`,
    `\terr := binary.Read(r, ${order}, &v)`,
    '\treturn v, err',
    '}',
    '',
    `// ${write} writes v to w, as the target stores it (${byteOrder(ctx)}).`,
    `func ${write}(w io.Writer, v *${rootType}) error {`,
    `\treturn binary.Write(w, ${order}, v)`,
    '}',
    '',
  );

  const sets: string[] = [];
  for (const l of leaves(root, { asBytes: carried, unionsAsBytes: true })) {
    const at = valuePath('value', l.path, (s) => fieldName.get(s.item)!);
    switch (l.type.kind) {
      case 'int': case 'float': sets.push(`${at} = ${l.value}`); break;
      case 'bool': sets.push(`${at} = true`); break;
      case 'pointer': if (!l.type.function) sets.push(`${at} = ${l.value}`); break;
      case 'bytes': {
        const v = l.value as number[];
        if (v.length <= LITERAL_BYTES) sets.push(`${at} = [${l.type.size}]byte{${list(v)}}`);
        else sets.push(`for j := range ${at} {`, `\t${at}[j] = byte(${v[0]} + j)`, '}');
        break;
      }
    }
  }
  const example = [
    'package bindings',
    '',
    'import (',
    '\t"bytes"',
    '\t"fmt"',
    ')',
    '',
    `// A round trip through the bytes ${root.cName} has on ${platformLine(ctx)}.`,
    `func Example${read}() {`,
    `\tvar value ${rootType}`,
    ...sets.map((s) => `\t${s}`),
    '',
    '\tvar data bytes.Buffer',
    `\tif err := ${write}(&data, &value); err != nil {`,
    '\t\tpanic(err)',
    '\t}',
    '\tsize := data.Len()',
    `\tback, err := ${read}(&data)`,
    '\tfmt.Println(size, err, back == value)',
    `\t// Output: ${root.size} <nil> true`,
    '}',
    '',
  ];
  return {
    code: out.join('\n'),
    example: { filename: `${root.name}_example_test.go`, code: example.join('\n') },
    usage: [
      `Put both files in one package and build it with GOARCH=${target.arch}: compiling it checks the layout, and fails for another GOARCH.`,
      `${read}(r) reads one from the bytes the target stores, and ${write}(w, &v) writes them.`,
      `In a module (go mod init example) with both files, go test runs the example's round trip, with GOARCH=${target.arch}.`,
    ],
  };
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

/** Whether a value of this type has a byte order: a scalar of more than one byte, or an array of them. */
function multiByte(t: BType): boolean {
  if (t.kind === 'array') return multiByte(t.element);
  return (t.kind === 'int' || t.kind === 'float' || t.kind === 'pointer') && t.size > 1;
}

/** Members C# gives the root struct, which a field may not be named. */
const CS_MEMBERS = new Set(['FromBytes', 'ToBytes']);

const emitCSharp: Emitter = (records, ctx) => {
  const root = ctx.root;
  // C# has no way to declare a byte order: fields are read in the machine's.
  if (ctx.bigEndian && records.some((r) => r.items.some((i) => i.kind !== 'bits' && multiByte(i.type)))) {
    ctx.notes.push("C# reads each field in the machine's byte order: on a little-endian machine, reverse the multi-byte fields of this big-endian target's data (BinaryPrimitives.ReverseEndianness).");
  }
  // A C# member may not have its type's name, nor that of the root's own members.
  const fieldName = (r: Record_, item: Item) => (item.name === r.name || (r === root && CS_MEMBERS.has(item.name)) ? `${item.name}_` : ident(item.name, 'csharp'));
  const out = [
    `// ${root.cName} on ${platformLine(ctx)}.`,
    "// Every field has its C offset: the same on any machine. Pointers are integers of the target's pointer size.",
    `// ${root.name}.FromBytes reads one from the bytes the target stores, and ToBytes gives them.`,
    '// Compile with AllowUnsafeBlocks (fixed-size buffers).',
    '',
    'using System;',
    'using System.Runtime.InteropServices;',
    '',
  ];
  for (const r of records) {
    out.push(`[StructLayout(LayoutKind.Explicit, Size = ${r.size})]`, `public unsafe struct ${r.name}`, '{');
    for (const item of r.items) {
      const at = `[FieldOffset(${item.offset})]`;
      if (item.kind === 'bits') {
        out.push(`    // ${bitsComment(item, ctx.bigEndian)}`, `    ${at} public fixed byte ${ident(item.name, 'csharp')}[${item.size}];`);
        continue;
      }
      const t = item.type;
      const name = fieldName(r, item);
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
    if (r === root) {
      out.push(
        '',
        `    /// <summary>One ${r.name} from the bytes the target stores for it.</summary>`,
        `    public static ${r.name} FromBytes(ReadOnlySpan<byte> bytes) => MemoryMarshal.Read<${r.name}>(bytes);`,
        '',
        `    /// <summary>The bytes the target stores for this ${r.name}.</summary>`,
        '    public readonly byte[] ToBytes()',
        '    {',
        `        var bytes = new byte[${r.size}];`,
        '        MemoryMarshal.Write(bytes, in this);',
        '        return bytes;',
        '    }',
      );
    }
    out.push('}', '');
  }

  // Where each value is in C#: a field, an element of a fixed buffer, or a field per element of an
  // array of structs; the bytes of a value C# carries as bytes start at `first` in its buffer.
  const place = (l: Leaf): { at: string; first: number } => {
    let at = '';
    let first = 0;
    for (let k = 0; k < l.path.length; k++) {
      const s = l.path[k]!;
      if (s.kind === 'field') {
        const next = l.path[k + 1];
        if (next?.kind === 'index' && next.type.element.kind === 'record') {
          at += `.${s.item.name}_${next.flat}`;
          k++;
        } else at += `.${s.item.kind === 'bits' ? ident(s.item.name, 'csharp') : fieldName(s.record, s.item)}`;
      } else if (s.kind === 'index') {
        if (s.type.element.kind === 'bytes') first = s.flat * s.type.element.size;
        else at += `[${s.flat}]`;
      }
    }
    return { at, first };
  };
  // Locals with no type's name: C# would read such a name as the type in some places.
  const taken = new Set(records.map((r) => r.name));
  const [value, data, back] = ['value', 'data', 'back'].map((n) => unique(n, taken));
  const sets: string[] = [];
  const checks: string[] = [];
  const fail = (what: string) => `throw new InvalidOperationException("${what} came back different.");`;
  for (const l of leaves(root)) {
    const { at: below, first } = place(l);
    const at = `${value}${below}`;
    const read = `${back}${below}`;
    const what = `${root.name}${below}`;
    switch (l.type.kind) {
      case 'int': case 'pointer': {
        sets.push(`${at} = ${l.value};`);
        checks.push(`if (${read} != ${l.value}) ${fail(what)}`);
        break;
      }
      case 'float': {
        const literal = `${l.value}${l.type.size === 4 ? 'f' : ''}`;
        sets.push(`${at} = ${literal};`);
        checks.push(`if (${read} != ${literal}) ${fail(what)}`);
        break;
      }
      case 'bool':
        sets.push(`${at} = 1;`);
        checks.push(`if (${read} != 1) ${fail(what)}`);
        break;
      case 'bytes': {
        const start = (l.value as number[])[0]!;
        const index = first > 0 ? `${first} + j` : 'j';
        sets.push(`for (var j = 0; j < ${l.type.size}; j++) ${at}[${index}] = (byte)((${start} + j) % 256);`);
        checks.push(`for (var j = 0; j < ${l.type.size}; j++) if (${read}[${index}] != (byte)((${start} + j) % 256)) ${fail(what)}`);
        break;
      }
    }
  }
  const runner = unique(`${root.name}RoundTrip`, new Set(records.map((r) => r.name)));
  const example = [
    `// A round trip through the bytes ${root.cName} has on ${platformLine(ctx)}.`,
    `// A program: in a console project with ${root.name}.cs and this file in place of Program.cs, dotnet run.`,
    'using System;',
    '',
    `public static class ${runner}`,
    '{',
    '    public static unsafe void Main()',
    '    {',
    `        var ${value} = new ${root.name}();`,
    ...sets.map((s) => `        ${s}`),
    '',
    `        byte[] ${data} = ${value}.ToBytes();`,
    `        ${root.name} ${back} = ${root.name}.FromBytes(${data});`,
    `        if (!${back}.ToBytes().AsSpan().SequenceEqual(${data})) ${fail(root.name)}`,
    ...checks.map((c) => `        ${c}`),
    `        Console.WriteLine($"${root.name}: {${data}.Length} bytes, the same after a round trip.");`,
    '    }',
    '}',
    '',
  ];
  return {
    code: out.join('\n'),
    example: { filename: `${runner}.cs`, code: example.join('\n') },
    usage: [
      `Add ${root.name}.cs to a project with AllowUnsafeBlocks: every field is at its C offset on any machine.`,
      `${root.name}.FromBytes(bytes) reads one from the bytes the target stores, and value.ToBytes() gives them.`,
      `dotnet new console, then ${root.name}.cs and ${runner}.cs in place of Program.cs, AllowUnsafeBlocks set, and dotnet run runs the round trip.`,
    ],
  };
};

// ------------------------------------------------------------------ Python

const PYTHON_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);

/** `base.name`, or getattr where the name is a Python keyword. */
const pyAttr = (base: string, name: string) => (PYTHON_KEYWORDS.has(name) ? `getattr(${base}, '${name}')` : `${base}.${name}`);

/** A Python literal for a sample value. */
function pyValue(v: Leaf['value']): string {
  if (typeof v === 'boolean') return 'True';
  if (!Array.isArray(v)) return String(v);
  return v.length <= LITERAL_BYTES ? `bytes([${list(v)}])` : `bytes((${v[0]} + j) % 256 for j in range(${v.length}))`;
}

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

/** The example's value for one struct code, the k-th: as sampleValue gives it for that type. */
function structSample(code: string, k: number): Leaf['value'] {
  const [, count, letter] = /^(\d*)([a-zA-Z?])$/.exec(code)!;
  if (letter === 's') return sampleValue({ kind: 'bytes', size: Number(count) }, k);
  if (letter === 'f' || letter === 'd') return sampleValue({ kind: 'float', size: letter === 'f' ? 4 : 8 }, k);
  if (letter === '?') return true;
  return sampleValue({ kind: 'int', size: 1, signed: true }, k);
}

const emitPythonStruct: Emitter = (records, ctx) => {
  const r = ctx.root;
  // A union is one value of its bytes, named after the union itself when it is the root.
  const codes = flattenStruct(r, r.union ? `${r.name}.` : '');
  const order = ctx.bigEndian ? '>' : '<';
  const constant = r.name.toUpperCase();
  for (const rec of records) if (rec.union) ctx.notes.push(`struct has no unions: ${rec.cName} is read as its ${rec.size} bytes.`);
  for (const rec of records) for (const item of rec.items) if (item.kind === 'bits') ctx.notes.push(`Bit-fields are read as the bytes they share: ${bitsComment(item, ctx.bigEndian)}.`);
  const named = codes.filter((c) => c.names.length > 0);
  const names = named.flatMap((c) => c.names);
  const lower = r.name.toLowerCase();
  const sample = named.map((c, k) => `'${c.names[0]}': ${pyValue(structSample(c.code, k + 1))}`);
  const code = [
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
    `def unpack_${lower}(buffer, offset=0):`,
    `    """The members of one ${r.cName} at \`offset\` in \`buffer\`, by name."""`,
    `    return dict(zip(${constant}_FIELDS, ${constant}.unpack_from(buffer, offset)))`,
    '',
    '',
    `def pack_${lower}(members):`,
    `    """The bytes of one ${r.cName}, from its members by name (as unpack_${lower} gives them)."""`,
    `    return ${constant}.pack(*(members[name] for name in ${constant}_FIELDS))`,
    '',
    '',
    "if __name__ == '__main__':",
    `    # A round trip through the bytes ${r.cName} has on the target.`,
    `    members = {${sample.join(', ')}}`,
    `    data = pack_${lower}(members)`,
    `    assert len(data) == ${r.size} and unpack_${lower}(data) == members`,
    `    print(unpack_${lower}(data))`,
    `    print(f'${r.name}: {len(data)} bytes, the same after a round trip')`,
    '',
  ];
  return {
    code: code.join('\n'),
    usage: [
      `Import ${r.name}.py: it checks the size of the format.`,
      `unpack_${lower}(buffer) reads one from the bytes the target stores, and pack_${lower}(members) writes them.`,
      `python ${r.name}.py runs its round trip.`,
    ],
  };
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
  const root = ctx.root;
  const endian = ctx.bigEndian ? 'BigEndian' : 'LittleEndian';
  const out = [
    `# ${root.cName} on ${platformLine(ctx)}.`,
    '# Packed, with C\'s padding written out: the layout is the same on any machine. In the',
    '# target\'s byte order, and with pointers as integers of its pointer size.',
    `# ${root.name}.from_buffer_copy(data) reads one from the bytes the target stores; bytes(value) gives them.`,
    'import ctypes',
    '',
  ];
  const field = (item: Item) => ident(item.name, 'python-ctypes');
  for (const r of records) {
    const { placed } = placeNatural(r, () => 1);
    out.push('', `class ${r.name}(ctypes.${endian}${r.union ? 'Union' : 'Structure'}):`, '    _pack_ = 1', "    _layout_ = 'ms'", '    _fields_ = [');
    for (const p of placed) {
      if ('pad' in p) out.push(`        ('${p.name}', ctypes.c_uint8 * ${p.pad}),`);
      else if (p.item.kind === 'bits') out.push(`        # ${bitsComment(p.item, ctx.bigEndian)}`, `        ('${field(p.item)}', ctypes.c_uint8 * ${p.item.size}),`);
      else out.push(`        ('${field(p.item)}', ${ctypesType(p.item.type, ctx.bigEndian)}),  # offset ${p.item.offset}`);
    }
    if (r.union) out.push(`        ('_size', ctypes.c_uint8 * ${r.size}),`);
    out.push('    ]', '', '', `assert ctypes.sizeof(${r.name}) == ${r.size}`);
    for (const item of r.items) out.push(`assert ${pyAttr(r.name, field(item))}.offset == ${item.offset}`);
  }

  // The example runs at module level: its names may not be a class's, nor ctypes.
  const taken = new Set([...records.map((r) => r.name), 'ctypes']);
  const [value, data, back] = ['value', 'data', 'back'].map((n) => unique(n, taken));
  const path = (base: string, steps: Step[]) =>
    steps.reduce((at, s) => (s.kind === 'field' ? pyAttr(at, field(s.item)) : s.kind === 'index' ? at + s.index.map((i) => `[${i}]`).join('') : at), base);
  const sets: string[] = [];
  const checks: string[] = [];
  for (const l of leaves(root)) {
    const at = path(value, l.path);
    const read = path(back, l.path);
    // A keyword member is set with setattr: the last step is its name.
    const last = l.path[l.path.length - 1]!;
    const assign = (v: string) =>
      last.kind === 'field' && PYTHON_KEYWORDS.has(field(last.item)) ? `setattr(${path(value, l.path.slice(0, -1))}, '${field(last.item)}', ${v})` : `${at} = ${v}`;
    switch (l.type.kind) {
      case 'bytes':
        sets.push(`${at}[:] = ${pyValue(l.value)}`);
        checks.push(`assert bytes(${read}) == ${pyValue(l.value)}`);
        break;
      case 'bool':
        sets.push(assign(ctx.bigEndian ? '1' : 'True'));
        checks.push(`assert ${read}`);
        break;
      default:
        sets.push(assign(pyValue(l.value)));
        checks.push(`assert ${read} == ${pyValue(l.value)}`);
    }
  }
  out.push(
    '',
    '',
    "if __name__ == '__main__':",
    `    # A round trip through the bytes ${root.cName} has on the target.`,
    `    ${value} = ${root.name}()`,
    ...sets.map((s) => `    ${s}`),
    `    ${data} = bytes(${value})`,
    `    ${back} = ${root.name}.from_buffer_copy(${data})`,
    `    assert len(${data}) == ${root.size} and bytes(${back}) == ${data}`,
    ...checks.map((c) => `    ${c}`),
    `    print(f'${root.name}: {len(${data})} bytes, the same after a round trip')`,
    '',
  );
  return {
    code: out.join('\n'),
    usage: [
      `Import ${root.name}.py: it checks the size and every offset of each Structure.`,
      `${root.name}.from_buffer_copy(data) reads one from the bytes the target stores, and bytes(value) gives them.`,
      `python ${root.name}.py runs its round trip.`,
    ],
  };
};

const EMITTERS: Record<BindingLanguage, Emitter> = {
  rust: emitRust,
  zig: emitZig,
  go: emitGo,
  csharp: emitCSharp,
  'python-struct': emitPythonStruct,
  'python-ctypes': emitPythonCtypes,
};
