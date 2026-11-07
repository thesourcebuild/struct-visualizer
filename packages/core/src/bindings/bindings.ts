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
  /**
   * What the binding calls the struct and each of its members, by C's name: C's own where the
   * language allows it (the notes say where it does not). A C# array of structs is a field per
   * element, and is named here by the first, at the member's offset.
   */
  names?: { root: BindingName; members: Record<string, BindingName> };
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

/** A name in the binding's language: what it is (`id`), and how the code writes it (`written`: r#type, @"u8"). */
export interface BindingName {
  id: string;
  written: string;
}
type Named = BindingName;

type Item = Named &
  (
    /** A C member at its offset; `align` is the alignment it has in this struct, `natural` its type's own. */
    | { kind: 'field'; name: string; offset: number; size: number; align: number; natural: number; type: BType; note?: string }
    /** A run of bit-fields, carried as the bytes their bits occupy; `name` is made from theirs. */
    | { kind: 'bits'; name: string; offset: number; size: number; fields: Array<{ name: string; bit: number; width: number }> }
  );

interface Record_ extends Named {
  union: boolean;
  size: number;
  align: number;
  /** `#pragma pack(n)` or packed: the largest alignment a member gets (Rust's packed(n)). */
  pack?: number;
  items: Item[];
  /** C's own name for it, for comments. */
  cName: string;
  /** C's tag, or for an anonymous record the record and member it is the type of. */
  tag: string | { parent: Record_; member: string };
  /** The names its fields have in the binding, and those added to them (padding), each taken once. */
  fieldIds: Set<string>;
}

// ------------------------------------------------------------------ names

/**
 * How a language writes a name: as it is, escaped where its rules allow (Rust's r#type, Zig's
 * @"u8", C#'s @class), or undefined where it cannot be that name at all.
 */
type Writer = (name: string) => string | undefined;

const RUST_KEYWORDS = new Set(['as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'async', 'await', 'dyn', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try', 'gen']);
/** Rust keywords that are no raw identifier either (r#self is an error), and the placeholder `_`. */
const RUST_UNRAW = new Set(['self', 'Self', 'super', 'crate', '_']);
/** The crates the Rust binding names in its paths (core::mem): a type of that name would hide them. */
const RUST_CRATES = new Set(['core', 'std']);
/** Rust's primitive types, which a type of the same name hides; core::primitive names them then. */
const RUST_PRIMITIVES = new Set(['bool', 'char', 'str', 'f32', 'f64', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize']);

const rustWrite = (name: string) => (RUST_UNRAW.has(name) ? undefined : RUST_KEYWORDS.has(name) ? `r#${name}` : name);

/** Zig 0.17's keywords (std.zig.Token.keywords). */
const ZIG_KEYWORDS = new Set(['addrspace', 'align', 'allowzero', 'and', 'anyframe', 'anytype', 'asm', 'break', 'callconv', 'catch', 'comptime', 'const', 'continue', 'defer', 'else', 'enum', 'errdefer', 'error', 'export', 'extern', 'fn', 'for', 'if', 'inline', 'noalias', 'noinline', 'nosuspend', 'opaque', 'or', 'orelse', 'packed', 'pub', 'resume', 'return', 'linksection', 'struct', 'suspend', 'switch', 'test', 'threadlocal', 'try', 'union', 'unreachable', 'var', 'volatile', 'while']);
/** Zig's primitive names (std.zig.primitives.isPrimitive), which a declaration may not shadow. */
const ZIG_PRIMITIVES = new Set(['anyerror', 'anyframe', 'anyopaque', 'bool', 'c_int', 'c_long', 'c_longdouble', 'c_longlong', 'c_char', 'c_short', 'c_uint', 'c_ulong', 'c_ulonglong', 'c_ushort', 'comptime_float', 'comptime_int', 'f128', 'f16', 'f32', 'f64', 'f80', 'false', 'isize', 'noreturn', 'null', 'true', 'type', 'undefined', 'usize', 'void']);
const zigPrimitive = (name: string) => ZIG_PRIMITIVES.has(name) || /^[iu]\d+$/.test(name);

const CS_KEYWORDS = new Set(['abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while', '__arglist', '__makeref', '__reftype', '__refvalue']);
/**
 * C#'s contextual keywords: names in some places (a type named var is what var means; record,
 * file, scoped and required may not name a type at all). Written with @, they are only names.
 */
const CS_CONTEXTUAL = new Set(['add', 'allows', 'alias', 'and', 'ascending', 'args', 'async', 'await', 'by', 'descending', 'dynamic', 'equals', 'extension', 'field', 'file', 'from', 'get', 'global', 'group', 'init', 'into', 'join', 'let', 'managed', 'nameof', 'nint', 'not', 'notnull', 'nuint', 'on', 'or', 'orderby', 'partial', 'record', 'remove', 'required', 'scoped', 'select', 'set', 'unmanaged', 'value', 'var', 'when', 'where', 'with', 'yield']);

const csWrite = (name: string) => (CS_KEYWORDS.has(name) || CS_CONTEXTUAL.has(name) ? `@${name}` : name);

const PYTHON_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
/** The module-level names the ctypes binding uses: a class of that name would hide them. */
const CTYPES_MODULE_NAMES = new Set(['ctypes', 'bytes', 'len', 'print', 'getattr', 'setattr', '__name__']);
/**
 * The attributes ctypes reads from a Structure or Union class (_fields_, _pack_), and those it and
 * its class have (Python 3.13's dir() of both): a field of that name would hide them.
 */
const CTYPES_ATTRIBUTES = new Set([
  '_fields_', '_pack_', '_layout_', '_anonymous_', '_align_', '_swappedbytes_', '_b_base_', '_b_needsfree_', '_objects',
  'from_address', 'from_buffer', 'from_buffer_copy', 'from_param', 'in_dll', 'mro',
  '__abstractmethods__', '__annotations__', '__base__', '__bases__', '__basicsize__', '__buffer__', '__call__', '__class__', '__ctypes_from_outparam__', '__delattr__', '__dict__', '__dictoffset__', '__dir__', '__doc__', '__eq__', '__firstlineno__', '__flags__', '__format__', '__ge__', '__getattribute__', '__getstate__', '__gt__', '__hash__', '__init__', '__init_subclass__', '__instancecheck__', '__itemsize__', '__le__', '__lt__', '__module__', '__mro__', '__mul__', '__name__', '__ne__', '__new__', '__or__', '__prepare__', '__qualname__', '__reduce__', '__reduce_ex__', '__repr__', '__rmul__', '__ror__', '__setattr__', '__setstate__', '__sizeof__', '__slots__', '__static_attributes__', '__str__', '__subclasscheck__', '__subclasses__', '__subclasshook__', '__text_signature__', '__type_params__', '__weakref__', '__weakrefoffset__',
]);

/**
 * How each language writes the names of records (types) and fields, and the names a root's fields
 * may not have because the binding gives the root a member of that name.
 */
const NAMES: Record<BindingLanguage, { type: Writer; field: Writer; rootMembers?: ReadonlySet<string> }> = {
  rust: { type: (n) => (RUST_CRATES.has(n) ? undefined : rustWrite(n)), field: rustWrite },
  // A declaration may not shadow a primitive, nor be `_`; @"u8" is a name that does neither.
  zig: { type: (n) => (ZIG_KEYWORDS.has(n) || zigPrimitive(n) || n === '_' ? `@"${n}"` : n), field: (n) => (ZIG_KEYWORDS.has(n) ? `@"${n}"` : n), rootMembers: new Set(['fromBytes']) },
  // Go exports each name (goExportedName), so none is a keyword or predeclared.
  go: { type: (n) => n, field: (n) => n },
  // The binding names everything else from global::System, which a type named System would hide.
  csharp: { type: (n) => (n === 'System' ? undefined : csWrite(n)), field: csWrite, rootMembers: new Set(['FromBytes', 'ToBytes']) },
  'python-struct': { type: (n) => n, field: (n) => n },
  // A keyword member is a field all the same, reached with getattr; a class must be a name.
  'python-ctypes': {
    type: (n) => (PYTHON_KEYWORDS.has(n) || CTYPES_MODULE_NAMES.has(n) ? undefined : n),
    field: (n) => (CTYPES_ATTRIBUTES.has(n) ? undefined : n),
  },
};

/**
 * The name `name` has in a language, taken in `taken`: C's own where the language can write it
 * and it is free, else with trailing underscores until it is both.
 */
function claim(name: string, write: Writer, taken: Set<string>): Named {
  let id = name;
  while (taken.has(id) || write(id) === undefined) id += '_';
  taken.add(id);
  return { id, written: write(id)! };
}

/**
 * Names every record and field as the language writes them. C's names come first, then those the
 * language must change: a record is renamed where it cannot have C's name, and an anonymous one
 * is named after the record and member it is the type of, none of them another's name. In each
 * record, the fields: C's members first, then the bit-field runs, each unique.
 */
function nameBinding(records: Record_[], root: Record_, language: BindingLanguage, notes: string[]): void {
  const { type, field, rootMembers } = NAMES[language];
  // C's names that the language can write and are free first, then the others renamed.
  const claimAll = (named: Array<{ to: Named; name: string; what: string }>, write: Writer, taken: Set<string>) => {
    const free = named.filter(({ name }) => write(name) !== undefined && !taken.has(name) && taken.add(name));
    for (const { name } of free) taken.delete(name);
    for (const { to, name, what } of [...free, ...named.filter((n) => !free.includes(n))]) {
      Object.assign(to, claim(name, write, taken));
      if (to.id !== name) notes.push(`${what} is named ${to.id}: the ${bindingLanguages[language].label} binding cannot name it ${name}.`);
    }
  };
  const types = new Set<string>();
  claimAll(records.flatMap((r) => (typeof r.tag === 'string' ? [{ to: r, name: r.tag, what: r.cName }] : [])), type, types);
  // Anonymous records after the records they are in: those come later in `records`.
  for (const r of [...records].reverse()) {
    if (typeof r.tag === 'string') continue;
    Object.assign(r, claim(`${r.tag.parent.id}_${r.tag.member}`, type, types));
  }
  for (const r of records) {
    // C# allows no member with its type's name; the root's members (FromBytes) are the binding's.
    r.fieldIds = new Set([...(language === 'csharp' ? [r.id] : []), ...(r === root ? (rootMembers ?? []) : [])]);
    claimAll(r.items.flatMap((item) => (item.kind === 'field' ? [{ to: item, name: item.name, what: `'${item.name}' in ${r.cName}` }] : [])), field, r.fieldIds);
    for (const item of r.items) if (item.kind === 'bits') Object.assign(item, claim(item.name, field, r.fieldIds));
  }
}

/** A name the binding adds to record `r` (padding, a union's size), none of its fields' names. */
const addedName = (r: Record_, name: string, language: BindingLanguage) => claim(name, NAMES[language].field, r.fieldIds).written;

/** C's signed and unsigned integer types, as the layout names them (after typedefs). */
const SIGNED = new Set(['signed char', 'short', 'int', 'long', 'long long', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'i8', 'i16', 'i32', 'i64', 'intptr_t', 'ptrdiff_t', 'ssize_t']);
const UNSIGNED = new Set(['unsigned char', 'unsigned short', 'unsigned int', 'unsigned long', 'unsigned long long', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'u8', 'u16', 'u32', 'u64', 'uintptr_t', 'size_t', 'char8_t', 'char16_t', 'char32_t']);

/** Builds the model of a laid-out record and the records it contains. */
class ModelBuilder {
  readonly records: Record_[] = [];
  private readonly byStruct = new Map<string, Record_>();
  readonly notes: string[] = [];

  constructor(
    private readonly calculator: PaddingCalculator,
    private readonly platform: ResolvedPlatform,
  ) {}

  record(result: CalculationResult, tag: Record_['tag']): Record_ {
    const key = `${result.struct.isUnion ? 'union' : 'struct'} ${result.struct.name}`;
    const known = this.byStruct.get(key);
    if (known) return known;
    const def = result.struct;
    // Named by nameBinding, for the language.
    const record: Record_ = {
      id: '',
      written: '',
      tag,
      fieldIds: new Set(),
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
        record.items.push({ kind: 'bits', name: `bits_${named.join('_') || start}`, id: '', written: '', offset: start, size: end - start, fields });
        continue;
      }
      const fieldName = m.name || `anon${anonymous++}`;
      const type = this.typeOf(m, e, { parent: record, member: fieldName });
      // The plain type's alignment, which is what another language's equivalent type has: no
      // request on the member, no aligned typedef.
      const natural = this.calculator.measure({ ...m, alignAttribute: undefined, packed: undefined, typeAlignment: undefined }).alignment;
      record.items.push({ kind: 'field', name: fieldName, id: '', written: '', offset: e.offset, size: e.size, align: e.alignment, natural, type });
    }
    this.records.push(record);
    return record;
  }

  private typeOf(m: StructMember, e: CalculationResult['members'][number], anonymous: Record_['tag']): BType {
    const dims = m.arrayDims ?? (m.arraySize !== undefined ? [m.arraySize] : []);
    const count = dims.reduce((a, b) => a * b, 1);
    const elementSize = dims.length === 0 ? e.size : count > 0 ? e.size / count : this.calculator.measure({ ...m, arraySize: undefined, arrayDims: undefined }).size;
    const element = this.scalarOf(m, elementSize, e.nested, anonymous);
    return dims.length > 0 ? { kind: 'array', dims, element } : element;
  }

  private scalarOf(m: StructMember, size: number, nested: CalculationResult | undefined, anonymous: Record_['tag']): BType {
    if (m.isNested && nested && !m.type.includes('*')) {
      return { kind: 'record', record: this.record(nested, nested.struct.name.startsWith('__anon_') ? anonymous : nested.struct.name) };
    }
    if (m.memberPointer) {
      this.notes.push(`'${m.name}' (${m.type}, a C++ pointer to member, ${size} bytes) has no equivalent and is carried as ${size} bytes.`);
      return { kind: 'bytes', size };
    }
    // std::nullptr_t has a pointer's size and holds its null.
    if (m.type.includes('*') || m.functionPointer || m.reference || m.type === 'nullptr_t') return { kind: 'pointer', size, function: m.functionPointer === true };
    if (m.enumType) return { kind: 'int', size, signed: m.enumType.members.some((v) => (v.value ?? 0) < 0) };
    const type = m.type.replace(/\b(const|volatile)\b/g, '').replace(/\s+/g, ' ').trim();
    if (['float', 'float32', 'f32'].includes(type) && size === 4) return { kind: 'float', size: 4 };
    if (['double', 'float64', 'f64'].includes(type) && size === 8) return { kind: 'float', size: 8 };
    if (type === 'long double' && size === 8) return { kind: 'float', size: 8 };
    if (/\b(float|double|_Complex)\b/.test(type) || type === '__int128' || type === 'unsigned __int128') {
      this.notes.push(`'${m.name}' (${type}, ${size} bytes) has no fixed-size equivalent and is carried as ${size} bytes.`);
      return { kind: 'bytes', size };
    }
    if (type === '_Bool' || type === 'bool') return { kind: 'bool' };
    if (size === 1 || size === 2 || size === 4 || size === 8) {
      // Plain char and wchar_t are signed or not as the target's compiler has them (measured).
      const arch = this.platform.architecture;
      const signed = type === 'char' ? arch.charSigned : type === 'wchar_t' ? arch.wcharSigned : SIGNED.has(type) ? true : UNSIGNED.has(type) ? false : undefined;
      if (signed !== undefined) return { kind: 'int', size, signed };
      this.notes.push(`Whether '${m.name}' (${type}) is signed on ${arch.displayName} is not known here, so it is carried as ${size} bytes.`);
      return { kind: 'bytes', size };
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
 * later than C did (C packed it) is carried as bytes, as is one `carried` says the language must
 * carry so. With `explicit`, every gap is a padding field, the trailing one too. Padding is named
 * for `language`, apart from the fields. Returns the placement and the language's own size and
 * alignment for the record without an alignment attribute.
 */
function placeNatural(
  record: Record_,
  align: (item: Item) => number,
  options: { language: BindingLanguage; explicit?: boolean; carried?: (item: Item) => boolean },
): { placed: Placed; size: number; align: number } {
  const { language, explicit = false, carried } = options;
  const placed: Placed = [];
  let pos = 0;
  let maxAlign = 1;
  let pads = 0;
  for (const item of record.items) {
    let bytes = carried?.(item) === true;
    let a = bytes ? 1 : align(item);
    if (record.union) {
      placed.push(bytes ? { item, bytes } : { item });
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
      placed.push({ pad: item.offset - pos, name: addedName(record, `_pad${pads++}`, language) });
    }
    placed.push(bytes ? { item, bytes } : { item });
    maxAlign = Math.max(maxAlign, a);
    pos = item.offset + item.size;
  }
  if (explicit ? pos < record.size : alignTo(pos, maxAlign) < record.size) {
    placed.push({ pad: record.size - pos, name: addedName(record, `_pad${pads++}`, language) });
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

/**
 * The offset of every bool outside a union, whose bytes must be 0 or 1 (unions take any bytes),
 * but in members the language carries as bytes.
 */
function boolOffsets(r: Record_, base = 0, carried: ReadonlySet<Item> = new Set()): number[] {
  if (r.union) return [];
  const ofType = (t: BType, offset: number, size: number): number[] => {
    if (t.kind === 'bool') return [offset];
    if (t.kind === 'record') return boolOffsets(t.record, offset, carried);
    if (t.kind !== 'array') return [];
    const count = t.dims.reduce((a, b) => a * b, 1);
    return Array.from({ length: count }, (_, k) => ofType(t.element, offset + (k * size) / count, size / count)).flat();
  };
  return r.items.flatMap((item) => (item.kind === 'field' && !carried.has(item) ? ofType(item.type, base + item.offset, item.size) : []));
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
    nameBinding(records, root, language, builder.notes);
    const ctx: EmitContext = { platform, notes: builder.notes, bigEndian: platform.architecture.endianness === 'big', pointerSize: platform.architecture.pointerSize, root };
    const { code, example, usage } = EMITTERS[language](records, ctx);
    const name = ({ id, written }: Named) => ({ id, written });
    const names = { root: name(root), members: Object.fromEntries(root.items.flatMap((i) => (i.kind === 'field' ? [[i.name, name(i)]] : []))) };
    return { code, filename, ...(example && { example }), usage, notes: [...new Set(ctx.notes)], names };
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

/**
 * A primitive type as the Rust binding writes it: by its name, or by core::primitive's where a
 * type of the binding has that name and so hides the primitive.
 */
type RustPrimitive = (name: string) => string;

const rustInt = (t: Extract<BType, { kind: 'int' }>, prim: RustPrimitive) => prim(`${t.signed ? 'i' : 'u'}${t.size * 8}`);

function rustType(t: BType, bytes: boolean, size: number, prim: RustPrimitive): string {
  if (bytes) return `[${prim('u8')}; ${size}]`;
  switch (t.kind) {
    case 'int': return rustInt(t, prim);
    case 'float': return prim(`f${t.size * 8}`);
    case 'bool': return prim('bool');
    case 'pointer': return t.function ? 'core::option::Option<unsafe extern "C" fn()>' : '*mut core::ffi::c_void';
    case 'record': return t.record.written;
    case 'bytes': return `[${prim('u8')}; ${t.size}]`;
    case 'array': return t.dims.reduceRight((inner, d) => `[${inner}; ${d}]`, rustType(t.element, false, 0, prim));
  }
}

/** A type with no Rust equivalent, carried as a byte array: aligned to 1 in Rust. */
const carriedAsBytes = (t: BType): boolean => t.kind === 'bytes' || (t.kind === 'array' && carriedAsBytes(t.element));

/** Whether a value of this type is or holds one of `records` (not behind a pointer). */
const holds = (t: BType, records: ReadonlySet<Record_>): boolean => (t.kind === 'record' ? records.has(t.record) : t.kind === 'array' && holds(t.element, records));

/** The Rust (or Zig, Go) expression for a value under `base`: its fields and indices. */
function valuePath(base: string, path: Step[], name: (s: Extract<Step, { kind: 'field' }>) => string): string {
  return base + path.map((s) => (s.kind === 'field' ? `.${name(s)}` : s.kind === 'index' ? s.index.map((i) => `[${i}]`).join('') : '.Raw')).join('');
}

/** C's name for the root, which an example prints. */
const rootTag = (root: Record_) => (typeof root.tag === 'string' ? root.tag : root.id);

const emitRust: Emitter = (records, ctx) => {
  const triple = rustTarget(ctx.platform);
  if (!triple) throw new BindingError(`Rust has no target for ${platformLine(ctx)}.`);
  const root = ctx.root;
  const types = new Set(records.map((r) => r.id));
  const prim: RustPrimitive = (name) => (RUST_PRIMITIVES.has(name) && types.has(name) ? `core::primitive::${name}` : name);
  const u8 = prim('u8');
  const out = [
    `// ${root.cName} on ${platformLine(ctx)}.`,
    `// #[repr(C)] follows the target's C layout: compile it for ${triple}, where the layout is checked.`,
    `// ${root.written}::from_bytes reads one from the bytes the target stores.`,
    '',
  ];
  const carried = new Set<Item>();
  // Records with an alignment of their own (repr(align)), or holding one: a packed record may not.
  const aligned = new Set<Record_>();
  for (const r of records) {
    const pack = r.pack;
    const overAligned = (item: Item) => pack !== undefined && item.kind === 'field' && holds(item.type, aligned);
    const { placed, align } = placeNatural(
      r,
      (item) => {
        if (item.kind === 'bits' || carriedAsBytes(item.type)) return 1;
        return pack !== undefined ? Math.min(item.natural, pack) : item.natural;
      },
      { language: 'rust', carried: overAligned },
    );
    const reprs = ['C'];
    if (pack !== undefined) reprs.push(`packed(${pack})`);
    if (r.align > Math.min(align, pack ?? Infinity)) {
      if (pack !== undefined) ctx.notes.push(`${r.cName} is packed and aligned to ${r.align}; Rust cannot say both, so it keeps packed(${pack}) and is aligned to ${Math.min(align, pack)}.`);
      else {
        reprs.push(`align(${r.align})`);
        aligned.add(r);
      }
    }
    out.push(`#[repr(${reprs.join(', ')})]`, '#[derive(Clone, Copy)]', `pub ${r.union ? 'union' : 'struct'} ${r.written} {`);
    for (const p of placed) {
      if ('pad' in p) out.push(`    pub ${p.name}: [${u8}; ${p.pad}],`);
      else if (p.item.kind === 'bits') out.push(`    /// ${bitsComment(p.item, ctx.bigEndian)}`, `    pub ${p.item.written}: [${u8}; ${p.item.size}],`);
      else {
        if (p.bytes) {
          carried.add(p.item);
          ctx.notes.push(
            overAligned(p.item)
              ? `'${p.item.name}' in ${r.cName} has a type aligned beyond its members, which Rust does not allow in a packed struct, so it is carried as ${p.item.size} bytes.`
              : `'${p.item.name}' in ${r.cName} is at an offset Rust's alignment for it does not allow, so it is carried as ${p.item.size} bytes.`,
          );
        } else if (holds(p.item.type, aligned)) aligned.add(r);
        out.push(`    pub ${p.item.written}: ${rustType(p.item.type, p.bytes === true, p.item.size, prim)}, // offset ${p.item.offset}`);
      }
    }
    if (r.union) {
      // A union's size can include padding of its own: a byte array of that size carries it.
      out.push(`    pub ${addedName(r, '_size', 'rust')}: [${u8}; ${r.size}],`);
    }
    out.push('}', '');
  }

  out.push('// The layout, checked when this file is compiled: built for another target, it fails here.', 'const _: () = {');
  for (const r of records) {
    out.push(`    assert!(core::mem::size_of::<${r.written}>() == ${r.size});`);
    for (const item of r.items) out.push(`    assert!(core::mem::offset_of!(${r.written}, ${item.written}) == ${item.offset});`);
  }
  out.push('};', '');

  // The round trip runs as a program (main, which prints with std; in a crate it is a function
  // of the module) and as a test. Both need std and a machine to run on: bare metal has neither.
  const hosted = ctx.platform.os !== 'none';
  // read_unaligned is sound only for bytes that are a valid value of every field: any are, but a
  // bool's, which must be 0 or 1 (a union's fields hold any bytes). With std, a reader that puts
  // the value on the heap: a struct can be larger than a thread's stack.
  const bools = boolOffsets(root, 0, carried);
  const array = `&[${u8}; ${root.size}]`;
  const check = bools.length > 0 ? [`        const BOOLS: [${prim('usize')}; ${bools.length}] = [${list(bools)}];`, '        if BOOLS.iter().any(|&i| bytes[i] > 1) {', '            return None;', '        }'] : [];
  const valid = bools.length > 0 ? `its bools are 0 or 1, and any bytes are a value of its other fields` : 'and any bytes are a value of each of its fields';
  const optional = (t: string) => (bools.length > 0 ? `core::option::Option<${t}>` : t);
  const some = (v: string) => (bools.length > 0 ? `Some(${v})` : v);
  out.push(
    `impl ${root.written} {`,
    `    /// One ${root.written} from the bytes the target stores for it${bools.length > 0 ? ', or None where a bool is neither 0 nor 1' : ''}.`,
    `    pub fn from_bytes(bytes: ${array}) -> ${optional('Self')} {`,
    ...check,
    `        // SAFETY: the array is as large as ${root.written}, ${valid}.`,
    `        ${some('unsafe { core::ptr::read_unaligned(bytes.as_ptr().cast()) }')}`,
    '    }',
  );
  if (hosted) {
    out.push(
      '',
      `    /// As from_bytes, on the heap: for one larger than the stack.`,
      `    pub fn boxed_from_bytes(bytes: ${array}) -> ${optional('std::boxed::Box<Self>')} {`,
      ...check,
      '        let mut value = std::boxed::Box::<Self>::new_uninit();',
      `        // SAFETY: the box is as large as ${root.written} and now holds these bytes, ${valid}.`,
      '        unsafe {',
      `            core::ptr::copy_nonoverlapping(bytes.as_ptr(), value.as_mut_ptr().cast::<${u8}>(), ${root.size});`,
      `            ${some('value.assume_init()')}`,
      '        }',
      '    }',
    );
  }
  out.push('}', '');

  const values = leaves(root, { asBytes: carried });
  const suffix = ctx.bigEndian ? 'be' : 'le';
  const writes: string[] = [];
  const checks: string[] = [];
  for (const l of values) {
    const range = `bytes[${l.offset}..${l.offset + (l.type.kind === 'bool' ? 1 : l.type.size)}]`;
    const at = valuePath('value', l.path, (s) => s.item.written);
    const read = l.inUnion ? `unsafe { ${at} }` : `{ ${at} }`;
    switch (l.type.kind) {
      case 'int':
        writes.push(`${range}.copy_from_slice(&${l.value}${l.type.signed ? 'i' : 'u'}${l.type.size * 8}.to_${suffix}_bytes());`);
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
          checks.push(`assert_eq!(${read} as ${prim('usize')}, ${l.value});`);
        }
        break;
      case 'bytes': {
        const v = l.value as number[];
        if (v.length <= LITERAL_BYTES) {
          writes.push(`${range}.copy_from_slice(&[${list(v)}]);`);
          checks.push(`assert_eq!(${read}, [${list(v)}]);`);
        } else {
          writes.push(`for (j, byte) in ${range}.iter_mut().enumerate() {`, `    *byte = (${v[0]} + j) as ${u8};`, '}');
          checks.push(`assert!(${read}.iter().enumerate().all(|(j, &byte)| byte == (${v[0]} + j) as ${u8}));`);
        }
        break;
      }
    }
  }
  if (hosted) {
    out.push(
      `/// ${root.cName} from the bytes the target stores: each value at its offset, ${byteOrder(ctx)}, read back.`,
      '/// The bytes and the value are on the heap, as one larger than the stack must be.',
      'fn round_trip() {',
      `    let ${writes.length > 0 ? 'mut ' : ''}bytes = vec![0u8; ${root.size}];`,
      ...writes.map((w) => `    ${w}`),
      `    let value = ${root.written}::boxed_from_bytes(bytes.first_chunk().unwrap())${bools.length > 0 ? '.unwrap()' : ''};`,
      ...checks.map((c) => `    ${c}`),
      '}',
      '',
      '/// Run as a program (rustc, or cargo run), the round trip, saying what it read.',
      'pub fn main() {',
      '    round_trip();',
      `    println!("${rootTag(root)}: each field read back from its ${root.size} bytes");`,
      '}',
      '',
      '#[cfg(test)]',
      `mod ${unique('tests', types)} {`,
      '    #[test]',
      '    fn from_bytes_reads_each_field() {',
      '        super::round_trip();',
      '    }',
      '}',
      '',
    );
  }
  const file = `${rootTag(root)}.rs`;
  return {
    code: out.join('\n'),
    usage: [
      `Add ${file} to a crate built for ${triple}: compiling it checks the layout, and fails for another target.`,
      `${root.written}::from_bytes(&bytes) reads one from the bytes the target stores${hosted ? `, and ${root.written}::boxed_from_bytes(&bytes) onto the heap` : ''}.`,
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
    // Aligned to 1, as anyopaque is: any address the bytes hold is a value of the pointer.
    case 'pointer': return t.function ? '?*align(1) const fn () callconv(.c) void' : '?*anyopaque';
    case 'record': return t.record.written;
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
    `// ${root.written}.fromBytes(&bytes) reads one in the bytes the target stores; std.mem.toBytes(value) gives them.`,
    '',
  ];
  // Locals and parameters may not shadow a declaration of the file: Zig forbids it.
  const taken = new Set(records.map((r) => r.id));
  const carried = new Set<Item>();
  for (const r of records) {
    // Each field gets the alignment C gives it in this struct, so a natural placement reproduces C.
    const { placed, align } = placeNatural(r, (item) => (item.kind === 'bits' ? 1 : item.align), { language: 'zig' });
    out.push(`pub const ${r.written} = extern ${r.union ? 'union' : 'struct'} {`);
    let first = true;
    for (const p of placed) {
      // The struct's own alignment, where C's is more than its members', goes on the first field.
      const raise = first && r.align > align ? r.align : undefined;
      first = false;
      if ('pad' in p) out.push(`    ${p.name}: [${p.pad}]u8${raise ? ` align(${raise})` : ''},`);
      else if (p.item.kind === 'bits') out.push(`    /// ${bitsComment(p.item, ctx.bigEndian)}`, `    ${p.item.written}: [${p.item.size}]u8${raise ? ` align(${raise})` : ''},`);
      else {
        if (p.bytes) carried.add(p.item);
        // Always the alignment C gives it here, so no field depends on Zig's own for its type.
        const a = raise ?? (p.bytes ? 1 : p.item.align);
        out.push(`    ${p.item.written}: ${zigType(p.item.type, p.bytes === true, p.item.size)} align(${a}), // offset ${p.item.offset}`);
      }
    }
    if (r.union) out.push(`    ${addedName(r, '_size', 'zig')}: [${r.size}]u8,`);
    if (r === root) {
      // In place, as std.mem.bytesAsValue reads: a copy (.*) of one larger than the stack would
      // not fit on it. Bytes are a value of every field but a bool, which must be 0 or 1.
      const bools = boolOffsets(root, 0, carried);
      const params = new Set(taken);
      const bytes = unique('bytes', params);
      const i = unique('i', params);
      const result = `*align(1) const @This()`;
      out.push(
        '',
        `    /// The ${root.written} in the bytes the target stores for it, read in place (.* copies it)${bools.length > 0 ? ', or error.InvalidBool where a bool is neither 0 nor 1' : ''}.`,
        `    pub fn fromBytes(${bytes}: *const [${root.size}]u8) ${bools.length > 0 ? `error{InvalidBool}!${result}` : result} {`,
        ...(bools.length > 0 ? [`        for ([_]usize{ ${list(bools)} }) |${i}| if (${bytes}[${i}] > 1) return error.InvalidBool;`] : []),
        `        return @import("std").mem.bytesAsValue(@This(), ${bytes});`,
        '    }',
      );
    }
    out.push('};', '');
  }

  out.push('// The layout, checked when this file is compiled: built for another target, it fails here.', 'comptime {');
  for (const r of records) {
    out.push(`    if (@sizeOf(${r.written}) != ${r.size}) @compileError("${r.id} is not ${r.size} bytes on this target");`);
    // @offsetOf takes a struct; a union's members are all at 0.
    if (!r.union) for (const item of r.items) out.push(`    if (@offsetOf(${r.written}, "${item.id}") != ${item.offset}) @compileError("${r.id}.${item.id} is not at offset ${item.offset} on this target");`);
  }
  out.push('}', '');

  const std = unique('std', taken);
  const bytes = unique('bytes', taken);
  const value = unique('value', taken);
  const byte = unique('byte', taken);
  const j = unique('j', taken);
  const bools = boolOffsets(root, 0, carried);
  const endian = ctx.bigEndian ? '.big' : '.little';
  const writes: string[] = [];
  const checks: string[] = [];
  for (const l of leaves(root, { asBytes: carried })) {
    const range = `${bytes}[${l.offset}..${l.offset + (l.type.kind === 'bool' ? 1 : l.type.size)}]`;
    const read = valuePath(value, l.path, (s) => s.item.written);
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
          // Through a pointer: the array itself would be a copy.
          writes.push(`for (${range}, 0..) |*${byte}, ${j}| ${byte}.* = @truncate(${v[0]} + ${j});`);
          checks.push(`for (&${read}, 0..) |${byte}, ${j}| try ${std}.testing.expectEqual(@as(u8, @truncate(${v[0]} + ${j})), ${byte});`);
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
      `test "${rootTag(root)} from the bytes the target stores" {`,
      `    try ${roundTrip}();`,
      '}',
      '',
    );
    if (runnable) {
      out.push(
        '/// Run as a program (zig run), the round trip, saying what it read.',
        'pub fn main() !void {',
        `    try ${roundTrip}();`,
        `    @import("std").debug.print("${rootTag(root)}: each field read back from its ${root.size} bytes\\n", .{});`,
        '}',
        '',
      );
    } else ctx.notes.push(`A type is named main, which a Zig program's entry point must be: the round trip runs with zig test only.`);
    out.push(
      `/// ${root.cName} from the bytes the target stores: each value at its offset, ${byteOrder(ctx)}, read back.`,
      '/// The bytes are on the heap, as those of one larger than the stack must be.',
      `fn ${roundTrip}() !void {`,
      `    const ${std} = @import("std");`,
      `    const ${bytes} = try ${std}.heap.page_allocator.create([${root.size}]u8);`,
      `    defer ${std}.heap.page_allocator.destroy(${bytes});`,
      `    @memset(${bytes}, 0);`,
      ...writes.map((w) => `    ${w}`),
      `    const ${value} = ${bools.length > 0 ? 'try ' : ''}${root.written}.fromBytes(${bytes});`,
      ...checks.map((c) => `    ${c}`),
      '}',
      '',
    );
  }
  const machine = target.split(' ')[0];
  const file = `${rootTag(root)}.zig`;
  return {
    code: out.join('\n'),
    usage: [
      `Build ${file} with -target ${target}: compiling it checks the layout, and fails for another target.`,
      `${root.written}.fromBytes(&bytes) reads one in the bytes the target stores${bools.length > 0 ? ', each bool 0 or 1' : ''}; std.mem.toBytes(value) gives them.`,
      ...(runnable ? [`On a ${machine} machine, zig run ${file} runs its round trip (and zig test ${file} as a test).`] : []),
      ...(hosted && !runnable ? [`On a ${machine} machine, zig test ${file} runs its round trip.`] : []),
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
  const typeName = new Map(records.map((r) => [r, unique(goExportedName(r.id), taken)] as const));
  for (const [r, name] of typeName) Object.assign(r, { id: name, written: name });
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
    const { placed, size, align } = placeNatural({ ...r, items }, (item) => (item.kind === 'bits' ? 1 : goAlign(item.type)), { language: 'go', explicit: true });
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
      const field = unique(goExportedName(p.item.id), fields);
      fieldName.set(p.item, field);
      Object.assign(p.item, { id: field, written: field });
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
    example: { filename: `${rootTag(root)}_example_test.go`, code: example.join('\n') },
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

/**
 * The .NET names the C# binding uses, written from global:: as generated code writes them: a type
 * of the C source (a struct named Console) hides no name so written, and no using is needed.
 */
const CS_INTEROP = 'global::System.Runtime.InteropServices';
const CS_MARSHAL = `${CS_INTEROP}.MemoryMarshal`;
const CS_SPAN = 'global::System.ReadOnlySpan<byte>';

const emitCSharp: Emitter = (records, ctx) => {
  const root = ctx.root;
  // C# has no way to declare a byte order: fields are read in the machine's.
  if (ctx.bigEndian && records.some((r) => r.items.some((i) => i.kind !== 'bits' && multiByte(i.type)))) {
    ctx.notes.push("C# reads each field in the machine's byte order: on a little-endian machine, reverse the multi-byte fields of this big-endian target's data (BinaryPrimitives.ReverseEndianness).");
  }
  // Locals and parameters with no type's name: C# would read such a name as the type in some places.
  const types = new Set(records.map((r) => r.id));
  const out = [
    `// ${root.cName} on ${platformLine(ctx)}.`,
    "// Every field has its C offset: the same on any machine. Pointers are integers of the target's pointer size.",
    `// ${root.written}.FromBytes reads one from the bytes the target stores, and ToBytes gives them.`,
    '// Compile with AllowUnsafeBlocks (fixed-size buffers).',
    '',
  ];
  // An array of records is a field per element (a fixed buffer holds only primitives), each named
  // for the member and its index, apart from the other fields.
  const elements = new Map<Item, Named[]>();
  for (const r of records) {
    out.push(`[${CS_INTEROP}.StructLayout(${CS_INTEROP}.LayoutKind.Explicit, Size = ${r.size})]`, `public unsafe struct ${r.written}`, '{');
    for (const item of r.items) {
      const at = `[${CS_INTEROP}.FieldOffset(${item.offset})]`;
      if (item.kind === 'bits') {
        out.push(`    // ${bitsComment(item, ctx.bigEndian)}`, `    ${at} public fixed byte ${item.written}[${item.size}];`);
        continue;
      }
      const t = item.type;
      if (t.kind === 'array') {
        const count = t.dims.reduce((a, b) => a * b, 1);
        if (count === 0) {
          ctx.notes.push(`C# has no flexible array members: ${r.cName}'s '${item.name}' is left out.`);
          continue;
        }
        const scalar = csScalar(t.element);
        if (scalar) {
          out.push(`    ${at} public fixed ${scalar} ${item.written}[${count}];${t.dims.length > 1 ? ` // [${t.dims.join('][')}]` : ''}`);
        } else if (t.element.kind === 'bytes') {
          out.push(`    ${at} public fixed byte ${item.written}[${count * t.element.size}];`);
        } else {
          const element = t.element.kind === 'record' ? t.element.record : undefined;
          const step = item.size / count;
          const names = Array.from({ length: count }, (_, k) => claim(`${item.id}_${k}`, NAMES.csharp.field, r.fieldIds));
          elements.set(item, names);
          Object.assign(item, names[0]);
          names.forEach((n, k) => out.push(`    [${CS_INTEROP}.FieldOffset(${item.offset + k * step})] public ${element!.written} ${n.written};`));
        }
        continue;
      }
      const scalar = csScalar(t);
      if (scalar) out.push(`    ${at} public ${scalar} ${item.written};${t.kind === 'pointer' ? ' // pointer' : t.kind === 'bool' ? ' // _Bool' : ''}`);
      else if (t.kind === 'record') out.push(`    ${at} public ${t.record.written} ${item.written};`);
      else out.push(`    ${at} public fixed byte ${item.written}[${item.size}];`);
    }
    if (r === root) {
      const locals = new Set(types);
      const [bytes, value] = ['bytes', 'value'].map((n) => unique(n, locals));
      out.push(
        '',
        `    /// <summary>One ${r.id} from the bytes the target stores for it.</summary>`,
        `    public static ${r.written} FromBytes(${CS_SPAN} ${bytes}) => ${CS_MARSHAL}.Read<${r.written}>(${bytes});`,
        '',
        `    /// <summary>One ${r.id} from the bytes the target stores for it, read into ${value} in place: for one larger than the stack.</summary>`,
        `    public static void FromBytes(${CS_SPAN} ${bytes}, out ${r.written} ${value})`,
        '    {',
        `        global::System.Runtime.CompilerServices.Unsafe.SkipInit(out ${value});`,
        `        ${bytes}.Slice(0, ${r.size}).CopyTo(${CS_MARSHAL}.AsBytes(${CS_MARSHAL}.CreateSpan(ref ${value}, 1)));`,
        '    }',
        '',
        `    /// <summary>The bytes the target stores for this ${r.id}.</summary>`,
        '    public readonly byte[] ToBytes()',
        '    {',
        `        byte[] ${bytes} = new byte[${r.size}];`,
        `        ${CS_MARSHAL}.Write(${bytes}, in this);`,
        `        return ${bytes};`,
        '    }',
      );
    }
    out.push('}', '');
  }

  // Where each value is in C# (`at`, and `label` to name it): a field, an element of a fixed
  // buffer, or a field per element of an array of structs; the bytes of a value C# carries as
  // bytes start at `first` in its buffer.
  const place = (l: Leaf): { at: string; label: string; first: number } => {
    let at = '';
    let label = '';
    let first = 0;
    for (let k = 0; k < l.path.length; k++) {
      const s = l.path[k]!;
      if (s.kind === 'field') {
        const next = l.path[k + 1];
        const element = next?.kind === 'index' && next.type.element.kind === 'record' ? elements.get(s.item)![next.flat]! : undefined;
        const name = element ?? s.item;
        at += `.${name.written}`;
        label += `.${name.id}`;
        if (element) k++;
      } else if (s.kind === 'index') {
        if (s.type.element.kind === 'bytes') first = s.flat * s.type.element.size;
        else {
          at += `[${s.flat}]`;
          label += `[${s.flat}]`;
        }
      }
    }
    return { at, label, first };
  };
  const locals = new Set(types);
  const [values, value, data, back, j] = ['values', 'value', 'data', 'back', 'j'].map((n) => unique(n, locals));
  const sets: string[] = [];
  const checks: string[] = [];
  const fail = (what: string) => `throw new global::System.InvalidOperationException("${what} came back different.");`;
  for (const l of leaves(root)) {
    const { at: below, label, first } = place(l);
    const at = `${value}${below}`;
    const read = `${back}${below}`;
    const what = `${rootTag(root)}${label}`;
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
        const index = first > 0 ? `${first} + ${j}` : j;
        sets.push(`for (int ${j} = 0; ${j} < ${l.type.size}; ${j}++) ${at}[${index}] = (byte)((${start} + ${j}) % 256);`);
        checks.push(`for (int ${j} = 0; ${j} < ${l.type.size}; ${j}++) if (${read}[${index}] != (byte)((${start} + ${j}) % 256)) ${fail(what)}`);
        break;
      }
    }
  }
  const runner = unique(`${root.id}RoundTrip`, new Set(types));
  const example = [
    `// A round trip through the bytes ${root.cName} has on ${platformLine(ctx)}.`,
    `// A program: in a console project with ${rootTag(root)}.cs and this file in place of Program.cs, dotnet run.`,
    `public static class ${runner}`,
    '{',
    '    public static unsafe void Main()',
    '    {',
    '        // The value and the one read back are in native memory: a large one would overflow the',
    '        // stack, and .NET makes no array of a value type that large.',
    `        ${root.written}* ${values} = (${root.written}*)${CS_INTEROP}.NativeMemory.AllocZeroed(2, (nuint)sizeof(${root.written}));`,
    '        try',
    '        {',
    `            ref ${root.written} ${value} = ref ${values}[0];`,
    ...sets.map((s) => `            ${s}`),
    '',
    `            byte[] ${data} = ${value}.ToBytes();`,
    `            ref ${root.written} ${back} = ref ${values}[1];`,
    `            ${root.written}.FromBytes(${data}, out ${back});`,
    `            if (!global::System.MemoryExtensions.SequenceEqual(global::System.MemoryExtensions.AsSpan(${back}.ToBytes()), ${data})) ${fail(rootTag(root))}`,
    ...checks.map((c) => `            ${c}`),
    `            global::System.Console.WriteLine($"${rootTag(root)}: {${data}.Length} bytes, the same after a round trip.");`,
    '        }',
    '        finally',
    '        {',
    `            ${CS_INTEROP}.NativeMemory.Free(${values});`,
    '        }',
    '    }',
    '}',
    '',
  ];
  return {
    code: out.join('\n'),
    example: { filename: `${runner}.cs`, code: example.join('\n') },
    usage: [
      `Add ${rootTag(root)}.cs to a project with AllowUnsafeBlocks: every field is at its C offset on any machine.`,
      `${root.written}.FromBytes(bytes) reads one from the bytes the target stores (FromBytes(bytes, out value) in place), and value.ToBytes() gives them.`,
      `dotnet new console, then ${rootTag(root)}.cs and ${runner}.cs in place of Program.cs, AllowUnsafeBlocks set, and dotnet run runs the round trip.`,
    ],
  };
};

// ------------------------------------------------------------------ Python

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
    if (item.kind === 'bits') codes.push({ code: `${item.size}s`, names: [`${prefix}${item.id}`] });
    else codes.push(...structCodes(item.type, `${prefix}${item.id}`, item.size));
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
  const tag = rootTag(r);
  const codes = flattenStruct(r, r.union ? `${tag}.` : '');
  const order = ctx.bigEndian ? '>' : '<';
  const constant = tag.toUpperCase();
  for (const rec of records) if (rec.union) ctx.notes.push(`struct has no unions: ${rec.cName} is read as its ${rec.size} bytes.`);
  for (const rec of records) for (const item of rec.items) if (item.kind === 'bits') ctx.notes.push(`Bit-fields are read as the bytes they share: ${bitsComment(item, ctx.bigEndian)}.`);
  const named = codes.filter((c) => c.names.length > 0);
  const names = named.flatMap((c) => c.names);
  const lower = tag.toLowerCase();
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
    `    print(f'${tag}: {len(data)} bytes, the same after a round trip')`,
    '',
  ];
  return {
    code: code.join('\n'),
    usage: [
      `Import ${tag}.py: it checks the size of the format.`,
      `unpack_${lower}(buffer) reads one from the bytes the target stores, and pack_${lower}(members) writes them.`,
      `python ${tag}.py runs its round trip.`,
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
    case 'record': return t.record.written;
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
    `# ${root.written}.from_buffer_copy(data) reads one from the bytes the target stores; bytes(value) gives them.`,
    'import ctypes',
    '',
  ];
  for (const r of records) {
    const { placed } = placeNatural(r, () => 1, { language: 'python-ctypes' });
    out.push('', `class ${r.written}(ctypes.${endian}${r.union ? 'Union' : 'Structure'}):`, '    _pack_ = 1', "    _layout_ = 'ms'", '    _fields_ = [');
    for (const p of placed) {
      if ('pad' in p) out.push(`        ('${p.name}', ctypes.c_uint8 * ${p.pad}),`);
      else if (p.item.kind === 'bits') out.push(`        # ${bitsComment(p.item, ctx.bigEndian)}`, `        ('${p.item.written}', ctypes.c_uint8 * ${p.item.size}),`);
      else out.push(`        ('${p.item.written}', ${ctypesType(p.item.type, ctx.bigEndian)}),  # offset ${p.item.offset}`);
    }
    if (r.union) out.push(`        ('${addedName(r, '_size', 'python-ctypes')}', ctypes.c_uint8 * ${r.size}),`);
    out.push('    ]', '', '', `assert ctypes.sizeof(${r.written}) == ${r.size}`);
    for (const item of r.items) out.push(`assert ${pyAttr(r.written, item.written)}.offset == ${item.offset}`);
  }

  // The example runs at module level: its names may not be a class's, nor one the module uses.
  const taken = new Set([...records.map((r) => r.id), ...CTYPES_MODULE_NAMES]);
  const [value, data, back] = ['value', 'data', 'back'].map((n) => unique(n, taken));
  const path = (base: string, steps: Step[]) =>
    steps.reduce((at, s) => (s.kind === 'field' ? pyAttr(at, s.item.written) : s.kind === 'index' ? at + s.index.map((i) => `[${i}]`).join('') : at), base);
  const sets: string[] = [];
  const checks: string[] = [];
  for (const l of leaves(root)) {
    const at = path(value, l.path);
    const read = path(back, l.path);
    // A keyword member is set with setattr: the last step is its name.
    const last = l.path[l.path.length - 1]!;
    const assign = (v: string) =>
      last.kind === 'field' && PYTHON_KEYWORDS.has(last.item.written) ? `setattr(${path(value, l.path.slice(0, -1))}, '${last.item.written}', ${v})` : `${at} = ${v}`;
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
    `    ${value} = ${root.written}()`,
    ...sets.map((s) => `    ${s}`),
    `    ${data} = bytes(${value})`,
    `    ${back} = ${root.written}.from_buffer_copy(${data})`,
    `    assert len(${data}) == ${root.size} and bytes(${back}) == ${data}`,
    ...checks.map((c) => `    ${c}`),
    `    print(f'${rootTag(root)}: {len(${data})} bytes, the same after a round trip')`,
    '',
  );
  return {
    code: out.join('\n'),
    usage: [
      `Import ${rootTag(root)}.py: it checks the size and every offset of each Structure.`,
      `${root.written}.from_buffer_copy(data) reads one from the bytes the target stores, and bytes(value) gives them.`,
      `python ${rootTag(root)}.py runs its round trip.`,
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
