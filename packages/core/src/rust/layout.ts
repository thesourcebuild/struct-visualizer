/**
 * Rust memory layout, following rustc's rustc_abi (univariant, layout_of_enum):
 *
 * - repr(Rust) structs, tuples and enum variants have their fields reordered: alignment groups
 *   largest first, with the largest niche placed first (or, when that leaves the niche in the
 *   middle, last). This is what rustc does today; the language does not guarantee it.
 * - repr(C) and repr(int) keep declaration order; packed(N) caps field alignment; align(N)
 *   raises the struct's; transparent has the layout of its one non-zero-size field.
 * - Niches: invalid bit patterns of bool, char, references, NonNull (and so Box, Vec, String),
 *   NonZero, fn pointers, enum tags and range-restricted scalars. Enums use them to store their
 *   discriminant (niche filling) when that is no larger than a separate tag.
 *
 * Standard types are written in their real form in ./std.ts and laid out by these same rules.
 */
import type { CalculationResult, ParseError, ParsedStruct, StructMember } from '../types';
import { INTEGER_TYPES, formatRustType, parseRust } from './parser';
import type { ConstExpr, GenericArg, GenericParam, RustEnum, RustField, RustFile, RustItem, RustRepr, RustStruct, RustType } from './parser';
import { RUST_PRELUDE, STD_ONLY } from './std';
import { getRustTarget } from './targets';
import type { RustTarget } from './targets';

/** A scalar's valid range [start..=end], wrapping, in its unsigned bit pattern. */
export interface Scalar {
  offset: number;
  bytes: number;
  start: bigint;
  end: bigint;
}

export interface Layout {
  size: number;
  align: number;
  /** The scalar with the most invalid values, if any. */
  niche?: Scalar;
  /** Scalar or scalar-pair ABI: the components a valid-range attribute applies to. */
  scalars?: Scalar[];
  uninhabited: boolean;
  /** Field-level layout for display (structs, tuples, unions, enums). */
  record?: CalculationResult;
}

export class RustLayoutError extends Error {
  constructor(
    message: string,
    public line?: number,
  ) {
    super(message);
  }
}

const alignUp = (n: number, a: number) => Math.ceil(n / a) * a;
const maxOf = (bytes: number) => (1n << BigInt(bytes * 8)) - 1n;

/** Number of invalid values of a scalar (what rustc calls the niche's `available`). */
export function nicheAvailable(s: Scalar | undefined): bigint {
  if (!s) return 0n;
  return (s.start - s.end - 1n) & maxOf(s.bytes);
}

function asNiche(s: Scalar): Scalar | undefined {
  return nicheAvailable(s) > 0n ? s : undefined;
}

const trailingZeros = (n: number) => {
  let z = 0;
  while (n > 1 && n % 2 === 0) {
    n /= 2;
    z += 1;
  }
  return z;
};

const is1Zst = (l: Layout) => l.size === 0 && l.align === 1;

interface FieldInput {
  name: string;
  type: string;
  line?: number;
  layout: Layout;
}

/**
 * rustc's StructKind: 'always' sized; 'maybeUnsized' when the last field's declared type may be
 * unsized (every non-empty tuple, and structs ending in a ?Sized parameter), which pins that
 * field last; 'prefixed' for enum variants placed after a tag.
 */
type StructKind = { kind: 'always' } | { kind: 'maybeUnsized' } | { kind: 'prefixed'; bytes: number; align: number };

interface Univariant {
  /** Field indexes in memory order. */
  order: number[];
  offsets: number[];
  size: number;
  align: number;
  niche?: Scalar;
  uninhabited: boolean;
}

/** rustc_abi univariant_biased. */
function univariantBiased(fields: readonly FieldInput[], repr: RustRepr, kind: StructKind, bias: 'start' | 'end'): Univariant {
  const pack = repr.packed;
  let align = 1;
  const order = fields.map((_, i) => i);
  const optimize = !(repr.c || repr.int !== undefined) && fields.length > 1;
  // A possibly-unsized last field keeps its place.
  const end = kind.kind === 'maybeUnsized' ? fields.length - 1 : fields.length;
  const head = fields.slice(0, end);

  if (optimize) {
    const maxFieldAlign = Math.max(1, ...head.map((f) => f.layout.align));
    const largestNicheSize = head.reduce((m, f) => {
      const a = nicheAvailable(f.layout.niche);
      return a > m ? a : m;
    }, 0n);
    const groupKey = (f: FieldInput): number => {
      if (pack !== undefined) return Math.min(f.layout.align, pack);
      const { align: a, size } = f.layout;
      let sizeAsAlign = trailingZeros(Math.max(a, size));
      if (largestNicheSize > 0n) {
        if (bias === 'start') sizeAsAlign = Math.min(trailingZeros(maxFieldAlign), sizeAsAlign);
        else if (nicheAvailable(f.layout.niche) === largestNicheSize) sizeAsAlign = trailingZeros(a);
      }
      return sizeAsAlign;
    };
    const cmpBig = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);
    const U64 = (1n << 64n) - 1n;
    const optimizing = order.slice(0, end);
    if (kind.kind !== 'prefixed') {
      optimizing.sort((i, j) => {
        const a = fields[i]!;
        const b = fields[j]!;
        // Larger alignment groups first.
        const g = groupKey(b) - groupKey(a);
        if (g !== 0) return g;
        const na = nicheAvailable(a.layout.niche);
        const nb = nicheAvailable(b.layout.niche);
        // Start: larger niches first (!niche_size ascending); End: larger niches last.
        const n = bias === 'start' ? cmpBig(nb, na) : cmpBig(na, nb);
        if (n !== 0) return n;
        const innerKey = (f: FieldInput): bigint => {
          const niche = f.layout.niche;
          if (!niche) return 0n;
          if (bias === 'start') return BigInt(niche.offset);
          return ~BigInt(f.layout.size - (niche.offset + niche.bytes)) & U64;
        };
        return cmpBig(innerKey(a), innerKey(b)) || i - j;
      });
    } else {
      // Prefixed (enum variants after a tag): ascending alignment, largest niche last.
      optimizing.sort((i, j) => {
        const a = fields[i]!;
        const b = fields[j]!;
        return groupKey(a) - groupKey(b) || cmpBig(nicheAvailable(a.layout.niche), nicheAvailable(b.layout.niche)) || i - j;
      });
    }
    order.splice(0, end, ...optimizing);
  }

  let offset = 0;
  if (kind.kind === 'prefixed') {
    const prefixAlign = pack !== undefined ? Math.min(kind.align, pack) : kind.align;
    align = Math.max(align, prefixAlign);
    offset = alignUp(kind.bytes, prefixAlign);
  }
  const offsets: number[] = new Array(fields.length).fill(0);
  let niche: Scalar | undefined;
  let nicheAvail = 0n;
  for (const i of order) {
    const f = fields[i]!;
    const fieldAlign = pack !== undefined ? Math.min(f.layout.align, pack) : f.layout.align;
    offset = alignUp(offset, fieldAlign);
    align = Math.max(align, fieldAlign);
    offsets[i] = offset;
    const fn = f.layout.niche;
    if (fn) {
      const available = nicheAvailable(fn);
      const prefer = bias === 'start' ? available > nicheAvail : available >= nicheAvail;
      if (prefer) {
        nicheAvail = available;
        niche = { ...fn, offset: fn.offset + offset };
      }
    }
    offset += f.layout.size;
  }
  if (repr.align !== undefined) align = Math.max(align, repr.align);
  return {
    order,
    offsets,
    size: alignUp(offset, align),
    align,
    niche,
    uninhabited: fields.some((f) => f.layout.uninhabited),
  };
}

/** rustc_abi univariant: the niche-at-start layout, or the niche-at-end one when that is better. */
function univariant(fields: readonly FieldInput[], repr: RustRepr, kind: StructKind): Univariant {
  const layout = univariantBiased(fields, repr, kind, 'start');
  const niche = layout.niche;
  // Not for possibly-unsized structs: Foo<T> and Foo<dyn Trait> must agree for unsizing.
  if (niche && kind.kind !== 'maybeUnsized') {
    const head = niche.offset;
    const tail = layout.size - head - niche.bytes;
    if (fields.length > 1 && head !== 0 && tail > 0) {
      const alt = univariantBiased(fields, repr, kind, 'end');
      const altHead = alt.niche!.offset;
      // The end-biased layout wins when its niche is further from the start than the
      // start-biased niche is from either edge.
      if (altHead > head && altHead > tail) return alt;
    }
  }
  return layout;
}

/** Display record for a laid-out struct, in memory order. */
function recordOf(name: string, fields: readonly FieldInput[], u: Univariant, isUnion = false, target = ''): CalculationResult {
  const members: CalculationResult['members'] = [];
  let end = 0;
  for (const i of u.order) {
    const f = fields[i]!;
    const offset = u.offsets[i]!;
    const member: StructMember = { name: f.name, type: f.type, line: f.line };
    if (f.layout.record) {
      member.isNested = true;
      member.nestedStruct = f.layout.record.struct;
    }
    members.push({
      member,
      offset,
      size: f.layout.size,
      padding: isUnion ? 0 : Math.max(0, offset - end),
      alignment: f.layout.align,
      nested: f.layout.record,
    });
    end = Math.max(end, offset + f.layout.size);
  }
  const dataBytes = isUnion ? Math.max(0, ...fields.map((f) => f.layout.size)) : fields.reduce((s, f) => s + f.layout.size, 0);
  const totalPadding = u.size - dataBytes;
  const struct: ParsedStruct = {
    name,
    members: members.map((m) => m.member),
    totalSize: u.size,
    alignment: u.align,
    totalPadding,
    isUnion,
  };
  return {
    struct,
    members,
    totalSize: u.size,
    totalPadding,
    wastedSpace: totalPadding,
    efficiency: u.size > 0 ? ((u.size - totalPadding) / u.size) * 100 : 100,
    architecture: target,
  };
}

// ------------------------------------------------------------------ engine

type Subst = Map<string, { kind: 'type'; type: RustType } | { kind: 'const'; value: bigint }>;

let preludeFile: RustFile | undefined;
function prelude(): RustFile {
  preludeFile ??= parseRust(RUST_PRELUDE);
  return preludeFile;
}

const C_TYPES: Record<string, string> = {
  c_char: 'i8', c_schar: 'i8', c_uchar: 'u8', c_short: 'i16', c_ushort: 'u16',
  c_longlong: 'i64', c_ulonglong: 'u64', c_float: 'f32',
};

/** core::sync::atomic's integer types and the width each needs. */
const ATOMIC_BITS: Record<string, number> = {
  AtomicBool: 8, AtomicU8: 8, AtomicI8: 8, AtomicU16: 16, AtomicI16: 16,
  AtomicU32: 32, AtomicI32: 32, AtomicU64: 64, AtomicI64: 64,
};

export interface EnumInfo {
  /** 'tagged' (separate discriminant), 'niche' (stored in another field's invalid values), 'single' or 'empty'. */
  encoding: 'tagged' | 'niche' | 'single' | 'empty';
  tag?: { offset: number; bytes: number; signed: boolean };
  /** For niche encoding: where the discriminant is stored. */
  nicheField?: Scalar;
  variants: { name: string; size: number; record: CalculationResult }[];
}

export class RustLayoutEngine {
  private cache = new Map<string, Layout>();
  private visiting = new Set<string>();
  readonly enumInfo = new Map<string, EnumInfo>();

  constructor(
    readonly target: RustTarget,
    private file: RustFile,
  ) {}

  // ---------------------------------------------------------------- items and names

  lookupItem(name: string): RustItem | undefined {
    return this.file.items.get(name) ?? prelude().items.get(name);
  }

  private intAlign(bytes: number): number {
    const a = this.target.align;
    return bytes === 1 ? 1 : bytes === 2 ? a.i16 : bytes === 4 ? a.i32 : bytes === 8 ? a.i64 : a.i128;
  }

  private intBytes(name: string): number {
    if (name === 'usize' || name === 'isize') return this.target.pointerBytes;
    return Number(/\d+/.exec(name)![0]) / 8;
  }

  private scalarLayout(bytes: number, align: number, start: bigint, end: bigint): Layout {
    const s: Scalar = { offset: 0, bytes, start, end };
    return { size: bytes, align, scalars: [s], niche: asNiche(s), uninhabited: false };
  }

  private primitive(name: string): Layout | undefined {
    if (INTEGER_TYPES.includes(name)) {
      const bytes = this.intBytes(name);
      return this.scalarLayout(bytes, this.intAlign(bytes), 0n, maxOf(bytes));
    }
    if (name in C_TYPES) return this.primitive(C_TYPES[name]!);
    switch (name) {
      case 'bool':
        return this.scalarLayout(1, 1, 0n, 1n);
      case 'char':
        return this.scalarLayout(4, this.target.align.i32, 0n, 0x10ffffn);
      case 'f32':
        return { size: 4, align: this.target.align.f32, scalars: [{ offset: 0, bytes: 4, start: 0n, end: maxOf(4) }], uninhabited: false };
      case 'f64':
        return { size: 8, align: this.target.align.f64, scalars: [{ offset: 0, bytes: 8, start: 0n, end: maxOf(8) }], uninhabited: false };
      case 'c_int':
      case 'c_uint':
        return this.primitive(`${name === 'c_int' ? 'i' : 'u'}${this.target.cIntBytes * 8}`);
      case 'c_long':
      case 'c_ulong':
        return this.primitive(`${name === 'c_long' ? 'i' : 'u'}${this.target.cLongBytes * 8}`);
      case 'c_double':
        return this.primitive(`f${this.target.cDoubleBytes * 8}`);
      case 'c_void':
        // An enum with two hidden variants: one byte, but only ever used behind a pointer.
        return this.scalarLayout(1, 1, 0n, 1n);
      default:
        return undefined;
    }
  }

  /** What a pointer to `type` carries besides the address. */
  private metadataOf(type: RustType, subst: Subst, depth = 0): 'none' | 'len' | 'vtable' {
    if (depth > 64) return 'none';
    switch (type.kind) {
      case 'slice':
        return 'len';
      case 'dyn':
        return 'vtable';
      case 'path': {
        const name = type.segments[type.segments.length - 1]!;
        if (type.segments.length === 1) {
          const bound = subst.get(name);
          if (bound?.kind === 'type') return this.metadataOf(bound.type, new Map(), depth + 1);
        }
        if (name === 'str' || name === 'CStr' || name === 'OsStr' || name === 'Path') return 'len';
        if (this.primitive(name)) return 'none';
        const item = this.lookupItem(name);
        if (!item) return 'none';
        const inner = this.bindGenerics(item, type.args, subst);
        if (item.kind === 'alias') return this.metadataOf(item.type, inner, depth + 1);
        if (item.kind === 'struct' && item.fields.length > 0) {
          return this.metadataOf(item.fields[item.fields.length - 1]!.type, inner, depth + 1);
        }
        return 'none';
      }
      default:
        return 'none';
    }
  }

  private pointer(pointee: RustType, subst: Subst, nonNull: boolean): Layout {
    const w = this.target.pointerBytes;
    const pa = this.target.pointerAlign;
    const data: Scalar = { offset: 0, bytes: w, start: nonNull ? 1n : 0n, end: maxOf(w) };
    const meta = this.metadataOf(pointee, subst);
    if (meta === 'none') return { size: w, align: pa, scalars: [data], niche: asNiche(data), uninhabited: false };
    const extra: Scalar = { offset: w, bytes: w, start: meta === 'vtable' ? 1n : 0n, end: maxOf(w) };
    // scalar_pair: the larger niche, preferring the first scalar on a tie.
    const a = nicheAvailable(data);
    const b = nicheAvailable(extra);
    const niche = a === 0n && b === 0n ? undefined : b > a ? extra : data;
    return { size: 2 * w, align: pa, scalars: [data, extra], niche, uninhabited: false };
  }

  /** Map an item's generic parameters to the arguments (or their defaults). */
  private bindGenerics(item: RustItem, args: readonly GenericArg[], outer: Subst): Subst {
    const subst: Subst = new Map();
    const params = item.generics;
    if (args.length > params.length) {
      throw new RustLayoutError(`'${item.name}' takes ${params.length} generic argument${params.length === 1 ? '' : 's'}, not ${args.length}.`, item.line);
    }
    params.forEach((p: GenericParam, i) => {
      const arg = args[i];
      if (p.kind === 'type') {
        let type: RustType | undefined;
        if (arg?.kind === 'type') type = substitute(arg.type, outer);
        else if (p.default) type = substitute(p.default, subst);
        if (!type) {
          throw new RustLayoutError(
            `'${item.name}' is generic: its layout depends on ${p.name}. Use it with a concrete type, e.g. ${item.name}<u32>.`,
            item.line,
          );
        }
        subst.set(p.name, { kind: 'type', type });
      } else {
        let expr: ConstExpr | undefined;
        if (arg?.kind === 'const') expr = arg.expr;
        else if (arg?.kind === 'type' && arg.type.kind === 'path' && arg.type.segments.length === 1 && arg.type.args.length === 0) {
          expr = { kind: 'path', segments: arg.type.segments };
        } else if (p.default) expr = p.default;
        if (!expr) throw new RustLayoutError(`'${item.name}' needs a value for its const parameter ${p.name}.`, item.line);
        subst.set(p.name, { kind: 'const', value: this.evalConst(expr, outer) });
      }
    });
    return subst;
  }

  // ---------------------------------------------------------------- constants

  evalConst(e: ConstExpr, subst: Subst, line?: number): bigint {
    switch (e.kind) {
      case 'lit':
        return e.suffix ? this.wrap(e.value, e.suffix) : e.value;
      case 'path': {
        const [first] = e.segments;
        if (e.segments.length === 1) {
          const bound = subst.get(first!);
          if (bound?.kind === 'const') return bound.value;
          const c = this.file.consts.get(first!) ?? prelude().consts.get(first!);
          if (c) {
            const v = this.evalConst(c.expr, new Map(), c.line);
            return c.type?.kind === 'path' && INTEGER_TYPES.includes(c.type.segments[0]!) ? this.wrap(v, c.type.segments[0]!) : v;
          }
          throw new RustLayoutError(`'${first}' is not a known integer constant.`, line);
        }
        const last = e.segments[e.segments.length - 1]!;
        const ty = e.segments[e.segments.length - 2]!;
        if (INTEGER_TYPES.includes(ty)) {
          const bits = BigInt(this.intBytes(ty) * 8);
          const signed = ty.startsWith('i');
          if (last === 'MAX') return signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
          if (last === 'MIN') return signed ? -(1n << (bits - 1n)) : 0n;
          if (last === 'BITS') return bits;
        }
        throw new RustLayoutError(`'${e.segments.join('::')}' is not a supported constant.`, line);
      }
      case 'unary': {
        const v = this.evalConst(e.arg, subst, line);
        return e.op === '-' ? -v : ~v;
      }
      case 'binary': {
        const l = this.evalConst(e.left, subst, line);
        const r = this.evalConst(e.right, subst, line);
        switch (e.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/':
          case '%':
            if (r === 0n) throw new RustLayoutError('Division by zero in a constant.', line);
            return e.op === '/' ? l / r : l % r;
          case '<<': return l << r;
          case '>>': return l >> r;
          case '&': return l & r;
          case '|': return l | r;
          case '^': return l ^ r;
          case '==': return l === r ? 1n : 0n;
          case '!=': return l !== r ? 1n : 0n;
          case '<': return l < r ? 1n : 0n;
          case '>': return l > r ? 1n : 0n;
          case '<=': return l <= r ? 1n : 0n;
          case '>=': return l >= r ? 1n : 0n;
          case '&&': return l !== 0n && r !== 0n ? 1n : 0n;
          case '||': return l !== 0n || r !== 0n ? 1n : 0n;
          default: throw new RustLayoutError(`Unsupported operator '${e.op}' in a constant.`, line);
        }
      }
      case 'cast': {
        const v = this.evalConst(e.arg, subst, line);
        return INTEGER_TYPES.includes(e.to) ? this.wrap(v, e.to) : v;
      }
      case 'size_of':
      case 'align_of': {
        const l = this.layoutOf(e.type, subst, line);
        return BigInt(e.kind === 'size_of' ? l.size : l.align);
      }
    }
  }

  /** Two's-complement wrap to an integer type, as `as` does. */
  private wrap(v: bigint, ty: string): bigint {
    if (!INTEGER_TYPES.includes(ty)) return v;
    const bits = BigInt(this.intBytes(ty) * 8);
    return ty.startsWith('i') ? BigInt.asIntN(Number(bits), v) : BigInt.asUintN(Number(bits), v);
  }

  // ---------------------------------------------------------------- types

  layoutOf(type: RustType, subst: Subst, line?: number): Layout {
    switch (type.kind) {
      case 'never':
        return { size: 0, align: 1, uninhabited: true };
      case 'ref':
        return this.pointer(type.elem, subst, true);
      case 'ptr':
        return this.pointer(type.elem, subst, false);
      case 'fn': {
        const w = this.target.pointerBytes;
        return this.scalarLayout(w, this.target.pointerAlign, 1n, maxOf(w));
      }
      case 'slice':
        throw new RustLayoutError(`[${formatRustType(type.elem)}] is a slice: it has no size on its own. Use it behind a pointer (&[T], Box<[T]>) or use an array [T; N].`, line);
      case 'dyn':
        throw new RustLayoutError(`'${type.source}' is a trait object: it has no size on its own. Use it behind a pointer (&dyn Trait, Box<dyn Trait>).`, line);
      case 'array': {
        const elem = this.layoutOf(type.elem, subst, line);
        const n = this.evalConst(type.len, subst, line);
        if (n < 0n) throw new RustLayoutError(`Array length ${n} is negative.`, line);
        const count = Number(n);
        return {
          size: elem.size * count,
          align: elem.align,
          niche: count > 0 ? elem.niche : undefined,
          uninhabited: count > 0 && elem.uninhabited,
        };
      }
      case 'tuple': {
        const fields = type.elems.map((t, i): FieldInput => ({ name: String(i), type: formatRustType(t), line, layout: this.layoutOf(t, subst, line) }));
        const kind: StructKind = fields.length > 0 ? { kind: 'maybeUnsized' } : { kind: 'always' };
        return this.struct(formatRustType(substitute(type, subst)), fields, { c: false, transparent: false }, kind);
      }
      case 'path':
        return this.pathLayout(type, subst, line);
    }
  }

  /** A standard type the target's core, alloc or std does not have, as rustc would say. */
  private checkAvailable(name: string, line?: number): void {
    const t = this.target;
    const bits = ATOMIC_BITS[name];
    if (bits !== undefined && !t.atomicBits.includes(bits)) {
      throw new RustLayoutError(`core::sync::atomic::${name} does not exist on ${t.id}: it has no ${bits}-bit atomics.`, line);
    }
    if (name === 'Arc' && !t.atomicCas) {
      throw new RustLayoutError(`alloc::sync::Arc does not exist on ${t.id}: it has no atomic compare-and-swap. Use Rc.`, line);
    }
    if (STD_ONLY.has(name) && !t.std) {
      throw new RustLayoutError(`${name} is in std, which ${t.id} does not have (no_std: only core and alloc).`, line);
    }
  }

  private pathLayout(type: Extract<RustType, { kind: 'path' }>, subst: Subst, line?: number): Layout {
    const name = type.segments[type.segments.length - 1]!;
    if (type.segments.length === 1) {
      const bound = subst.get(name);
      if (bound?.kind === 'type') return this.layoutOf(bound.type, new Map(), line);
      if (bound?.kind === 'const') throw new RustLayoutError(`'${name}' is a constant, not a type.`, line);
    }
    if (type.args.length === 0) {
      if (name === 'str') throw new RustLayoutError("'str' has no size on its own. Use &str, Box<str> or String.", line);
      const p = this.primitive(name);
      if (p && !this.file.items.has(name)) return p;
    }
    if (name === 'Self') throw new RustLayoutError("'Self' is only meaningful inside an impl.", line);
    if (name === 'Cow') return this.cow(type, subst, line);

    const item = this.lookupItem(name);
    if (!item) {
      throw new RustLayoutError(
        `Unknown type '${formatRustType(type)}'. Define it in the input, or use a standard type this tool knows (Box, Vec, String, Option, Rc, Arc, HashMap, ...).`,
        line,
      );
    }
    if (!this.file.items.has(name)) this.checkAvailable(name, line);
    const inner = this.bindGenerics(item, type.args, subst);
    const key = `${name}<${[...inner.entries()].map(([k, v]) => `${k}=${v.kind === 'type' ? formatRustType(v.type) : v.value}`).join(',')}>`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.visiting.has(key)) {
      throw new RustLayoutError(`'${name}' contains itself without indirection, so its size would be infinite. Use Box<${name}>.`, item.line);
    }
    this.visiting.add(key);
    try {
      const display = item.generics.length > 0 ? formatRustType({ kind: 'path', segments: [name], args: [...inner.values()].map((v) => (v.kind === 'type' ? { kind: 'type' as const, type: v.type } : { kind: 'const' as const, expr: { kind: 'lit' as const, value: v.value } })) }) : name;
      const layout = this.itemLayout(item, inner, display);
      this.cache.set(key, layout);
      return layout;
    } finally {
      this.visiting.delete(key);
    }
  }

  /** Cow<'a, B> is Borrowed(&B) or Owned(B::Owned): String for str, Vec<T> for [T], B otherwise. */
  private cow(type: Extract<RustType, { kind: 'path' }>, subst: Subst, line?: number): Layout {
    const arg = type.args.find((a) => a.kind === 'type');
    if (!arg || arg.kind !== 'type') throw new RustLayoutError('Cow needs a type argument, e.g. Cow<str>.', line);
    const b = substitute(arg.type, subst);
    const owned: RustType =
      b.kind === 'path' && b.segments[b.segments.length - 1] === 'str'
        ? { kind: 'path', segments: ['String'], args: [] }
        : b.kind === 'slice'
          ? { kind: 'path', segments: ['Vec'], args: [{ kind: 'type', type: b.elem }] }
          : b;
    const cowEnum: RustEnum = {
      kind: 'enum',
      name: 'Cow',
      generics: [],
      repr: { c: false, transparent: false },
      variants: [
        { name: 'Borrowed', tuple: true, fields: [{ name: '0', type: { kind: 'ref', mutable: false, elem: b }, line: 0 }], line: 0 },
        { name: 'Owned', tuple: true, fields: [{ name: '0', type: owned, line: 0 }], line: 0 },
      ],
      line: 0,
    };
    return this.enumLayout(cowEnum, new Map(), `Cow<${formatRustType(b)}>`);
  }

  private fieldInputs(fields: readonly RustField[], subst: Subst): FieldInput[] {
    return fields.map((f) => ({
      name: f.name,
      type: formatRustType(substitute(f.type, subst)),
      line: f.line,
      layout: this.layoutOf(f.type, subst, f.line),
    }));
  }

  private itemLayout(item: RustItem, subst: Subst, display: string): Layout {
    if (item.kind === 'alias') return this.layoutOf(item.type, subst, item.line);
    if (item.kind === 'enum') return this.enumLayout(item, subst, display);
    this.checkSized(item, subst);
    const fields = this.fieldInputs(item.fields, subst);
    if (item.kind === 'union') return this.union(display, fields, item.repr);
    if (item.repr.transparent) {
      const nonZst = fields.filter((f) => !is1Zst(f.layout));
      if (nonZst.length > 1) throw new RustLayoutError(`repr(transparent) struct '${item.name}' has more than one non-zero-size field.`, item.line);
    }
    if (item.repr.packed !== undefined && item.repr.align !== undefined) {
      throw new RustLayoutError(`'${item.name}' cannot be both packed and aligned.`, item.line);
    }
    const layout = this.struct(display, fields, item.repr, this.structKind(item));
    return this.applyItemAttributes(item, layout, subst);
  }

  private checkSized(item: RustStruct, subst: Subst) {
    const last = item.fields[item.fields.length - 1];
    if (last && this.metadataOf(last.type, subst) !== 'none') {
      throw new RustLayoutError(
        `'${item.name}' is dynamically sized: its last field '${last.name}: ${formatRustType(last.type)}' has no fixed size. Only pointers to it (&${item.name}, Box<${item.name}>) have a layout.`,
        last.line,
      );
    }
  }

  /** #[rustc_layout_scalar_valid_range_*] and UnsafeCell's niche hiding. */
  private applyItemAttributes(item: RustStruct, layout: Layout, subst: Subst): Layout {
    if (item.unsafeCell) {
      const scalars = layout.scalars?.map((s) => ({ ...s, start: 0n, end: maxOf(s.bytes) }));
      return { ...layout, scalars, niche: undefined };
    }
    if (!item.validRange) return layout;
    const first = layout.scalars?.[0];
    if (!first) throw new RustLayoutError(`A valid-range attribute needs a single scalar field ('${item.name}').`, item.line);
    const mask = maxOf(first.bytes);
    const start = item.validRange.start ? this.evalConst(item.validRange.start, subst, item.line) & mask : first.start;
    const end = item.validRange.end ? this.evalConst(item.validRange.end, subst, item.line) & mask : first.end;
    const scalars = [{ ...first, start, end }, ...layout.scalars!.slice(1)];
    const niches = scalars.map((s) => asNiche(s)).filter((s): s is Scalar => !!s);
    const niche = niches.reduce<Scalar | undefined>((best, s) => (!best || nicheAvailable(s) > nicheAvailable(best) ? s : best), undefined);
    return { ...layout, scalars, niche };
  }

  /** A struct or tuple. */
  struct(name: string, fields: readonly FieldInput[], repr: RustRepr, kind: StructKind): Layout {
    const u = univariant(fields, repr, kind);
    const record = recordOf(name, fields, u, false, this.target.id);
    // Scalar ABI passes through a struct with one non-zero-size field that fills it.
    let scalars: Scalar[] | undefined;
    const nonZst = fields.map((f, i) => ({ f, i })).filter(({ f }) => !is1Zst(f.layout));
    if (repr.packed === undefined && nonZst.length === 1) {
      const { f, i } = nonZst[0]!;
      if (u.offsets[i] === 0 && f.layout.size === u.size && f.layout.align === u.align && f.layout.scalars) scalars = f.layout.scalars;
    }
    return { size: u.size, align: u.align, niche: u.niche, scalars, uninhabited: u.uninhabited, record };
  }

  private union(name: string, fields: readonly FieldInput[], repr: RustRepr): Layout {
    const pack = repr.packed;
    let align = 1;
    let size = 0;
    for (const f of fields) {
      align = Math.max(align, pack !== undefined ? Math.min(f.layout.align, pack) : f.layout.align);
      size = Math.max(size, f.layout.size);
    }
    if (repr.align !== undefined) align = Math.max(align, repr.align);
    const u: Univariant = { order: fields.map((_, i) => i), offsets: fields.map(() => 0), size: alignUp(size, align), align, uninhabited: false };
    return { size: u.size, align, uninhabited: false, record: recordOf(name, fields, u, true, this.target.id) };
  }

  // ---------------------------------------------------------------- enums

  /** Integer::repr_discr: the discriminant's size and signedness. */
  private reprDiscr(repr: RustRepr, min: bigint, max: bigint): { bytes: number; signed: boolean } {
    const fitUnsigned = (v: bigint) => [1, 2, 4, 8, 16].find((b) => v <= maxOf(b)) ?? 16;
    const fitSigned = (v: bigint) => [1, 2, 4, 8, 16].find((b) => v >= -(1n << BigInt(b * 8 - 1)) && v < 1n << BigInt(b * 8 - 1)) ?? 16;
    if (repr.int) {
      const bytes = this.intBytes(repr.int);
      const signed = repr.int.startsWith('i');
      const fit = signed ? Math.max(fitSigned(min), fitSigned(max)) : fitUnsigned(max);
      if (bytes < fit || (!signed && min < 0n)) throw new RustLayoutError(`A discriminant does not fit in repr(${repr.int}).`);
      return { bytes, signed };
    }
    const atLeast = repr.c ? this.target.cEnumMinBytes : 1;
    if (min >= 0n) return { bytes: Math.max(fitUnsigned(max), atLeast), signed: false };
    return { bytes: Math.max(fitSigned(min), fitSigned(max), atLeast), signed: true };
  }

  /** Niche::reserve: claim `count` invalid values, preferring the path to zero. */
  private reserve(niche: Scalar, count: bigint): { start: bigint; scalar: Scalar } | undefined {
    const max = maxOf(niche.bytes);
    const available = nicheAvailable(niche);
    if (count > available) return undefined;
    const moveStart = () => {
      const start = (niche.start - count) & max;
      return { start, scalar: { ...niche, start } };
    };
    const moveEnd = () => {
      const start = (niche.end + 1n) & max;
      const end = (niche.end + count) & max;
      return { start, scalar: { ...niche, end } };
    };
    const distanceEndZero = max - niche.end;
    if (niche.start > niche.end) return moveEnd();
    if (niche.start <= distanceEndZero) return count <= niche.start ? moveStart() : moveEnd();
    const end = (niche.end + count) & max;
    const overshotZero = end >= 1n && end <= niche.end;
    return overshotZero ? moveStart() : moveEnd();
  }

  private enumLayout(item: RustEnum, subst: Subst, display: string): Layout {
    const repr = item.repr;
    const variants = item.variants.map((v) => this.fieldInputs(v.fields, subst));
    const absent = (fields: FieldInput[]) => fields.some((f) => f.layout.uninhabited) && fields.every((f) => is1Zst(f.layout));
    const inhibit = repr.c || repr.int !== undefined;

    if (variants.length === 0) {
      this.enumInfo.set(display, { encoding: 'empty', variants: [] });
      return { size: 0, align: 1, uninhabited: true, record: emptyRecord(display, this.target.id) };
    }
    const present = variants.map((v, i) => i).filter((i) => repr.c || !absent(variants[i]!));
    if (present.length === 0) {
      this.enumInfo.set(display, { encoding: 'empty', variants: [] });
      return { size: 0, align: 1, uninhabited: true, record: emptyRecord(display, this.target.id) };
    }

    // One variant that matters and no repr: laid out as that variant's struct, no discriminant.
    if (!inhibit && present.length === 1) {
      const v = present[0]!;
      const fields = variants[v]!;
      const u = univariant(fields, repr, { kind: 'always' });
      const variantRecord = recordOf(item.variants[v]!.name, fields, u, false, this.target.id);
      this.enumInfo.set(display, { encoding: 'single', variants: [{ name: item.variants[v]!.name, size: u.size, record: variantRecord }] });
      return {
        size: u.size,
        align: u.align,
        niche: u.niche,
        uninhabited: u.uninhabited,
        record: enumRecord(display, u.size, u.align, [{ name: item.variants[v]!.name, record: variantRecord }], this.target.id),
      };
    }

    // Discriminant values and range (uninhabited variants do not count, except for repr(C)).
    const discrs: bigint[] = [];
    let next = 0n;
    for (const v of item.variants) {
      const value = v.discriminant ? this.evalConst(v.discriminant, subst, v.line) : next;
      discrs.push(value);
      next = value + 1n;
    }
    let min: bigint | undefined;
    let max: bigint | undefined;
    variants.forEach((fields, i) => {
      if (!repr.c && fields.some((f) => f.layout.uninhabited)) return;
      const d = discrs[i]!;
      if (min === undefined || d < min) min = d;
      if (max === undefined || d > max) max = d;
    });
    min ??= 0n;
    max ??= 0n;
    const minIty = this.reprDiscr(repr, min, max);

    const niche = inhibit ? undefined : this.nicheFilling(item, variants, absent, repr, display);
    const tagged = this.tagged(item, variants, repr, minIty, min, max, display);

    let best = tagged;
    if (niche) {
      const tagNiche = nicheAvailable(tagged.layout.niche);
      const nicheNiche = nicheAvailable(niche.layout.niche);
      if (tagged.layout.size > niche.layout.size || (tagged.layout.size === niche.layout.size && tagNiche < nicheNiche)) best = niche;
    }
    this.enumInfo.set(display, best.info);
    return best.layout;
  }

  private nicheFilling(
    item: RustEnum,
    variants: FieldInput[][],
    absent: (f: FieldInput[]) => boolean,
    repr: RustRepr,
    display: string,
  ): { layout: Layout; info: EnumInfo } | undefined {
    if (variants.length < 2) return undefined;
    const layouts = variants.map((fields) => univariant(fields, repr, { kind: 'always' }));
    let largest = 0;
    layouts.forEach((l, i) => {
      if (l.size >= layouts[largest]!.size) largest = i; // max_by_key: the last of equals
    });
    const needsDisc = (i: number) => i !== largest && !absent(variants[i]!);
    const indices = variants.map((_, i) => i).filter(needsDisc);
    if (indices.length === 0) return undefined;
    const count = BigInt(indices[indices.length - 1]! - indices[0]! + 1);
    const niche = layouts[largest]!.niche;
    if (!niche) return undefined;
    const reserved = this.reserve(niche, count);
    if (!reserved) return undefined;

    let align = Math.max(...layouts.map((l) => l.align));
    if (repr.align !== undefined) align = Math.max(align, repr.align);
    const size = alignUp(layouts[largest]!.size, align);
    const shift: number[] = layouts.map(() => 0);
    for (let i = 0; i < layouts.length; i++) {
      if (i === largest) continue;
      const l = layouts[i]!;
      if (l.size <= niche.offset) continue;
      const at = alignUp(niche.offset + niche.bytes, l.align);
      if (at + l.size > size) return undefined;
      shift[i] = at;
    }
    // Each variant spans the enum; variants without the niche field show where their
    // discriminant is stored instead.
    const nicheMarker: FieldInput = {
      name: '(niche)',
      type: `discriminant stored in invalid values of the ${niche.bytes}-byte field at offset ${niche.offset}`,
      layout: { size: niche.bytes, align: 1, uninhabited: false },
    };
    const variantInfo = layouts.map((l, i) => {
      const fields = [...variants[i]!];
      const offsets = l.offsets.map((o) => o + shift[i]!);
      if (needsDisc(i)) {
        fields.push(nicheMarker);
        offsets.push(niche.offset);
      }
      const order = fields.map((_, k) => k).sort((a, b) => offsets[a]! - offsets[b]! || a - b);
      const u: Univariant = { ...l, order, offsets, size };
      return { name: item.variants[i]!.name, size: l.size, record: recordOf(item.variants[i]!.name, fields, u, false, this.target.id) };
    });
    const nicheField = reserved.scalar;
    const record = enumRecord(display, size, align, variantInfo, this.target.id);
    return {
      layout: { size, align, niche: asNiche(nicheField), uninhabited: layouts.every((l) => l.uninhabited), record },
      info: { encoding: 'niche', nicheField, variants: variantInfo },
    };
  }

  private tagged(
    item: RustEnum,
    variants: FieldInput[][],
    repr: RustRepr,
    minIty: { bytes: number; signed: boolean },
    min: bigint,
    max: bigint,
    display: string,
  ): { layout: Layout; info: EnumInfo } {
    let prefixAlign = this.intAlign(minIty.bytes);
    if (repr.c) for (const fields of variants) for (const f of fields) prefixAlign = Math.max(prefixAlign, f.layout.align);
    let startAlign = 256;
    let size = 0;
    let align = 1;
    const layouts = variants.map((fields) => {
      const u = univariant(fields, repr, { kind: 'prefixed', bytes: minIty.bytes, align: prefixAlign });
      const byOffset = [...u.order].sort((a, b) => u.offsets[a]! - u.offsets[b]! || a - b);
      const first = byOffset.find((i) => !is1Zst(fields[i]!.layout));
      if (first !== undefined) startAlign = Math.min(startAlign, fields[first]!.layout.align);
      size = Math.max(size, u.size);
      align = Math.max(align, u.align);
      return u;
    });
    if (repr.align !== undefined) align = Math.max(align, repr.align);
    size = alignUp(size, align);

    // Widen the tag to the first fields' alignment when that is free (avoids partial copies).
    let tagBytes = minIty.bytes;
    if (!(repr.c || repr.int !== undefined)) {
      const forAlign = [1, 2, 4, 8, 16].find((b) => b === startAlign && this.intAlign(b) === startAlign);
      if (forAlign !== undefined && forAlign > tagBytes) tagBytes = forAlign;
    }
    const mask = maxOf(tagBytes);
    const tag: Scalar = { offset: 0, bytes: tagBytes, start: min & mask, end: max & mask };
    const tagField: FieldInput = {
      name: '(discriminant)',
      type: `${minIty.signed ? 'i' : 'u'}${tagBytes * 8}`,
      layout: { size: tagBytes, align: this.intAlign(tagBytes), uninhabited: false },
    };
    const variantInfo = layouts.map((u, i) => {
      const fields = [tagField, ...variants[i]!];
      const withTag: Univariant = { ...u, order: [0, ...u.order.map((k) => k + 1)], offsets: [0, ...u.offsets], size };
      return { name: item.variants[i]!.name, size: u.size, record: recordOf(item.variants[i]!.name, fields, withTag, false, this.target.id) };
    });
    const record = enumRecord(display, size, align, variantInfo, this.target.id);
    return {
      layout: { size, align, niche: asNiche(tag), scalars: variants.every((v) => v.length === 0) ? [tag] : undefined, uninhabited: layouts.every((l) => l.uninhabited), record },
      info: { encoding: 'tagged', tag: { offset: 0, bytes: tagBytes, signed: minIty.signed }, variants: variantInfo },
    };
  }

  // ---------------------------------------------------------------- root

  /** Layout of a named item with no generic arguments (the analysis root). */
  rootLayout(name: string): Layout {
    return this.pathLayout({ kind: 'path', segments: [name], args: [] }, new Map());
  }

  /** The same item laid out with a different repr (for the optimized-order suggestion). */
  withRepr(item: RustStruct, repr: RustRepr): Layout {
    const fields = this.fieldInputs(item.fields, new Map());
    return this.struct(item.name, fields, repr, this.structKind(item));
  }

  /** MaybeUnsized when the last field's declared (generic) type could be unsized. */
  private structKind(item: RustStruct): StructKind {
    const last = item.fields[item.fields.length - 1];
    if (!last) return { kind: 'always' };
    const params = new Map(item.generics.map((g) => [g.name, g.kind === 'type' && g.maybeUnsized === true]));
    return this.declaredMaybeUnsized(last.type, params, 0) ? { kind: 'maybeUnsized' } : { kind: 'always' };
  }

  private declaredMaybeUnsized(type: RustType, params: Map<string, boolean>, depth: number): boolean {
    if (depth > 32) return false;
    switch (type.kind) {
      case 'slice':
      case 'dyn':
        return true;
      case 'tuple':
        return type.elems.length > 0 && this.declaredMaybeUnsized(type.elems[type.elems.length - 1]!, params, depth + 1);
      case 'path': {
        const name = type.segments[type.segments.length - 1]!;
        if (type.segments.length === 1 && params.has(name)) return params.get(name)!;
        if (name === 'str' || name === 'CStr' || name === 'OsStr' || name === 'Path') return true;
        const item = this.lookupItem(name);
        if (!item || item.kind === 'enum' || item.kind === 'union') return false;
        const inner = new Map(
          item.generics.map((g, i) => {
            const arg = type.args.filter((a) => a.kind === 'type')[i];
            const unsized = g.kind === 'type' && g.maybeUnsized === true && arg?.kind === 'type' && this.declaredMaybeUnsized(arg.type, params, depth + 1);
            return [g.name, unsized];
          }),
        );
        if (item.kind === 'alias') return this.declaredMaybeUnsized(item.type, inner, depth + 1);
        const last = item.fields[item.fields.length - 1];
        return !!last && this.declaredMaybeUnsized(last.type, inner, depth + 1);
      }
      default:
        return false;
    }
  }
}

function emptyRecord(name: string, target: string): CalculationResult {
  return {
    struct: { name, members: [], totalSize: 0, alignment: 1, totalPadding: 0 },
    members: [],
    totalSize: 0,
    totalPadding: 0,
    wastedSpace: 0,
    efficiency: 100,
    architecture: target,
  };
}

/** An enum as a union of its variants, each a record with absolute offsets. */
function enumRecord(
  name: string,
  size: number,
  align: number,
  variants: readonly { name: string; record: CalculationResult }[],
  target: string,
): CalculationResult {
  const members: CalculationResult['members'] = variants.map((v) => {
    const member: StructMember = { name: v.name, type: 'variant', isNested: true, nestedStruct: v.record.struct };
    // The variant's extent: up to the end of its last field (or discriminant).
    const extent = Math.max(0, ...v.record.members.map((m) => m.offset + m.size));
    return { member, offset: 0, size: extent, padding: 0, alignment: v.record.struct.alignment ?? 1, nested: v.record };
  });
  const used = Math.max(0, ...variants.map((v) => v.record.members.reduce((s, m) => s + m.size, 0)));
  const totalPadding = size - used;
  return {
    struct: { name, members: members.map((m) => m.member), totalSize: size, alignment: align, totalPadding, isUnion: true, isEnum: true },
    members,
    totalSize: size,
    totalPadding,
    wastedSpace: totalPadding,
    efficiency: size > 0 ? (used / size) * 100 : 100,
    architecture: target,
  };
}

/** Replace generic parameters in a type. */
export function substitute(type: RustType, subst: Subst): RustType {
  switch (type.kind) {
    case 'path': {
      if (type.segments.length === 1 && type.args.length === 0) {
        const bound = subst.get(type.segments[0]!);
        if (bound?.kind === 'type') return bound.type;
      }
      return {
        ...type,
        args: type.args.map((a) => (a.kind === 'type' ? { kind: 'type', type: substitute(a.type, subst) } : a)),
      };
    }
    case 'ref':
    case 'ptr':
    case 'slice':
      return { ...type, elem: substitute(type.elem, subst) };
    case 'array': {
      const len = type.len.kind === 'path' && type.len.segments.length === 1 ? subst.get(type.len.segments[0]!) : undefined;
      return { ...type, elem: substitute(type.elem, subst), len: len?.kind === 'const' ? { kind: 'lit', value: len.value } : type.len };
    }
    case 'tuple':
      return { ...type, elems: type.elems.map((t) => substitute(t, subst)) };
    default:
      return type;
  }
}

// ------------------------------------------------------------------ analysis

export interface RustAnalysis {
  target: RustTarget;
  file: RustFile;
  errors: ParseError[];
  warnings: ParseError[];
  definition: { name: string; kind: 'struct' | 'union' | 'enum'; line: number; repr: RustRepr } | null;
  result: CalculationResult | null;
  /** repr(C) structs: the same fields in rustc's order (what repr(Rust) would do). */
  optimized: CalculationResult | null;
  /** Field names in the suggested declaration order, when it differs. */
  optimizedOrder: string[] | null;
  /** Layout facts: invalid values available to enclosing enums, and Option<T>'s size. */
  niche: { offset: number; bytes: number; available: bigint } | null;
  optionSize: number | null;
  enumInfo: EnumInfo | null;
  /** Item names declared but not used by the one laid out. */
  unusedTypes: string[];
}

export function analyzeRust(code: string, targetId: string): RustAnalysis {
  const target = getRustTarget(targetId);
  const file = parseRust(code);
  const analysis: RustAnalysis = {
    target,
    file,
    errors: [...file.errors],
    warnings: [...file.warnings],
    definition: null,
    result: null,
    optimized: null,
    optimizedOrder: null,
    niche: null,
    optionSize: null,
    enumInfo: null,
    unusedTypes: [],
  };
  if (analysis.errors.length > 0) return analysis;

  const candidates = file.order.filter((n) => {
    const item = file.items.get(n)!;
    return item.kind !== 'alias' && item.generics.length === 0;
  });
  const rootName = candidates[candidates.length - 1];
  if (!rootName) {
    const generic = file.order.find((n) => file.items.get(n)!.generics.length > 0);
    analysis.errors.push({
      message: generic
        ? `'${generic}' is generic, so it has no layout until it is used with concrete types. Add a struct that uses it, e.g. struct Example { v: ${generic}<u32> }.`
        : 'No struct, union or enum found. Define one, e.g. struct Example { a: u8, b: u32 }.',
      type: 'semantic',
    });
    return analysis;
  }

  const item = file.items.get(rootName) as RustStruct | RustEnum;
  analysis.definition = { name: rootName, kind: item.kind, line: item.line, repr: item.repr };
  const engine = new RustLayoutEngine(target, file);
  try {
    const layout = engine.rootLayout(rootName);
    analysis.result = layout.record ?? null;
    analysis.niche = layout.niche ? { offset: layout.niche.offset, bytes: layout.niche.bytes, available: nicheAvailable(layout.niche) } : null;
    analysis.enumInfo = item.kind === 'enum' ? (engine.enumInfo.get(rootName) ?? null) : null;
    analysis.optionSize = engine.layoutOf({ kind: 'path', segments: ['Option'], args: [{ kind: 'type', type: { kind: 'path', segments: [rootName], args: [] } }] }, new Map()).size;

    // repr(C) structs keep declaration order; suggest rustc's order, which is minimal.
    if (item.kind === 'struct' && item.repr.c && !item.repr.transparent && item.fields.length > 1 && analysis.result) {
      const rustRepr: RustRepr = { ...item.repr, c: false };
      const alt = engine.withRepr(item, rustRepr).record!;
      const order = alt.members.map((m) => m.member.name);
      if (alt.totalSize < analysis.result.totalSize) {
        analysis.optimizedOrder = order;
        analysis.optimized = engine.withRepr({ ...item, fields: order.map((n) => item.fields.find((f) => f.name === n)!) }, item.repr).record!;
      }
    }
    analysis.unusedTypes = findUnused(file, rootName);
  } catch (err) {
    if (!(err instanceof RustLayoutError)) throw err;
    analysis.errors.push({ message: err.message, line: err.line, type: 'semantic' });
    analysis.result = null;
  }
  return analysis;
}

/** Items the root does not reach through its field types. */
function findUnused(file: RustFile, root: string): string[] {
  const used = new Set<string>([root]);
  const visitType = (t: RustType) => {
    switch (t.kind) {
      case 'path': {
        const name = t.segments[t.segments.length - 1]!;
        const item = file.items.get(name);
        if (item && !used.has(name)) {
          used.add(name);
          visitItem(item);
        }
        t.args.forEach((a) => {
          if (a.kind === 'type') visitType(a.type);
        });
        return;
      }
      case 'ref':
      case 'ptr':
      case 'slice':
      case 'array':
        visitType(t.elem);
        return;
      case 'tuple':
        t.elems.forEach(visitType);
        return;
      default:
        return;
    }
  };
  const visitItem = (item: RustItem) => {
    if (item.kind === 'alias') visitType(item.type);
    else if (item.kind === 'enum') item.variants.forEach((v) => v.fields.forEach((f) => visitType(f.type)));
    else item.fields.forEach((f) => visitType(f.type));
  };
  visitItem(file.items.get(root)!);
  return file.order.filter((n) => !used.has(n) && file.items.get(n)!.kind !== 'alias');
}
