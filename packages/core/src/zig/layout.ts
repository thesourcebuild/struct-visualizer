/**
 * Zig memory layout, as Zig 0.17 computes it (src/Type.zig abiSize/abiAlignment/classify and
 * src/Sema/type_resolution.zig), with the comptime evaluation a type needs on the way: constants,
 * builtins (@sizeOf, @alignOf, @bitSizeOf, @offsetOf, @This, @Vector, @Int, @typeInfo), calls of
 * functions that return types, and `if`.
 *
 * - struct: the compiler sorts the fields by descending alignment (`mem.sortUnstable`, a pdq
 *   sort, so equal alignments keep whatever order pdq leaves) and places them in that order.
 *   Tuples and extern structs keep declaration order.
 * - packed struct and packed union: an integer of the fields' total bit width.
 * - union: the largest field, plus a tag when the union is tagged, or, in Debug and ReleaseSafe,
 *   a hidden safety tag for a bare union. The tag goes first unless the payload is more aligned.
 * - enum: its integer tag type, explicit or the smallest unsigned integer that counts the fields.
 * - ?T: the payload alone for pointers (also slices) and error sets, else T and a flag that adds
 *   T's alignment. E!T: an error code (u16) and the payload, the more aligned one first.
 */
import { Nesting, NestingError } from '../nesting';
import type { CalculationResult, ParseError, ParsedStruct, StructMember } from '../types';
import { parseZig } from './parser';
import type { ContainerDecl, Decl, Expr, FieldDecl, FnDecl, Stmt, SwitchProng, ZigFile } from './parser';
import { pdqSort } from './sort';
import { ZIG_STD } from './std';
import {
  cTypeAlignment,
  cTypeBitSize,
  cTypeByteSize,
  compilerRtFloatAbi,
  floatLayout,
  getZigCpu,
  getZigTarget,
  intAlignment,
  intByteSize,
  isBigEndian,
  minFunctionAlignment,
  OPTIMIZE_FIELD,
  ptrBits,
  runtimeSafety,
  stackAlignment,
  zigBackend,
} from './targets';
import type { CType, ZigBuildMode, ZigCpu, ZigTarget } from './targets';

// ------------------------------------------------------------------ types and values

export type ZType =
  | { k: 'int'; signed: boolean; bits: number }
  | { k: 'usize' | 'isize' }
  | { k: 'c'; c: CType; signed: boolean; name: string }
  | { k: 'float'; bits: 16 | 32 | 64 | 80 | 128 }
  | { k: 'c_longdouble' }
  | { k: 'bool' | 'void' | 'noreturn' | 'anyopaque' }
  | { k: 'comptime'; name: 'type' | 'comptime_int' | 'comptime_float' | '@EnumLiteral()' | '@TypeOf(null)' | '@TypeOf(undefined)' }
  | { k: 'ptr'; size: 'one' | 'many' | 'slice' | 'c'; child: ZType; isConst: boolean; isVolatile: boolean; allowzero: boolean; align?: number; sentinel?: string }
  | { k: 'array'; len: number; sentinel?: string; child: ZType }
  | { k: 'vector'; len: number; child: ZType }
  | { k: 'opt'; child: ZType }
  | { k: 'errset'; names: string[] | null }
  | { k: 'errunion'; set: ZType; payload: ZType }
  /** A function type: its text, and its identity (each parameter's and the return type's). */
  | { k: 'fn'; text: string; key: string; callconv?: string }
  | { k: 'container'; c: Container };

type Value =
  | { k: 'type'; t: ZType }
  /** An integer: comptime_int, or of a fixed-width type (`const n: u16 = 3`), which @clz needs. */
  | { k: 'int'; v: bigint; type?: ZType }
  /** A float: comptime_float, or of a float type it was coerced to. */
  | { k: 'float'; text: string; type?: ZType }
  | { k: 'bool'; v: boolean }
  | { k: 'enumLit'; name: string }
  | { k: 'enumValue'; type: Container; name: string }
  | { k: 'string'; v: string }
  | { k: 'null' | 'undefined' | 'void' | 'init' }
  | { k: 'fn'; fn: FnDecl; scope: Scope; name: string; id: number }
  /** A struct value: its fields by name, and its type where it has a named one. */
  | { k: 'record'; fields: Map<string, Value>; type?: ZType }
  /** A tagged union value (std.builtin.Type, as @typeInfo gives it): only its active field can be read. */
  | { k: 'union'; tag: string; payload: Value; type?: ZType }
  /** A value of an optional type: the payload, or null; and the optional type, where known. */
  | { k: 'optional'; v: Value | null; type?: ZType }
  /** Something the engine does not represent (a container's declarations): an error to use. */
  | { k: 'unmodelled'; what: string };

/** Type.Class: what values a type has. */
type Class = 'npv' | 'opv' | 'runtime' | 'partial' | 'comptime';

interface ResolvedField {
  name: string;
  type: ZType;
  /** Written as `align(n)`. */
  align?: number;
  comptime: boolean;
  line: number;
  decl: FieldDecl;
}

export interface Container {
  id: number;
  name: string;
  decl: ContainerDecl;
  /** The container's namespace; its parent is where it was written. */
  scope: Scope;
  tuple: boolean;
  fields?: ResolvedField[];
  layout?: ZLayout;
  resolving?: boolean;
  /** Enums: the integer tag type and each field's value. */
  enumInfo?: { tag: ZType; inferred: boolean; values: bigint[] };
}

export interface ZLayout {
  size: number;
  align: number;
  cls: Class;
  record?: CalculationResult;
}

export class ZigLayoutError extends Error {
  constructor(
    message: string,
    public line?: number,
  ) {
    super(message);
  }
}

class Scope {
  readonly bindings = new Map<string, Binding>();
  /** The container whose namespace this is. */
  container?: Container;

  constructor(
    readonly parent: Scope | undefined,
    /** Part of the std prelude, which is another file: its declarations must be pub to the user's code. */
    readonly prelude = false,
  ) {}

  lookup(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.lookup(name);
  }

  get isPrelude(): boolean {
    return this.prelude || (this.parent?.isPrelude ?? false);
  }

  nearestContainer(): Container | undefined {
    return this.container ?? this.parent?.nearestContainer();
  }
}

type Binding = { k: 'value'; v: Value } | { k: 'decl'; decl: Decl; scope: Scope; state?: 'evaluating' | 'done'; v?: Value };

const alignForward = (n: number, a: number) => Math.ceil(n / Math.max(1, a)) * Math.max(1, a);
const ceilPow2 = (n: number) => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};
/** Type.smallestUnsignedBits */
const smallestUnsignedBits = (max: number) => (max <= 0 ? 0 : Math.floor(Math.log2(max)) + 1);

/** The bytes of a string in UTF-8, as Zig stores a string literal. */
function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** A decimal float literal's exact value, num / den; undefined for a hex float. */
function rationalOf(text: string): { num: bigint; den: bigint } | undefined {
  const m = /^(-?)(\d[\d_]*)(?:\.([\d_]*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) return undefined;
  const frac = (m[3] ?? '').replace(/_/g, '');
  let num = BigInt(m[2]!.replace(/_/g, '') + frac);
  let den = 10n ** BigInt(frac.length);
  const exp = Number(m[4] ?? 0);
  if (exp >= 0) num *= 10n ** BigInt(exp);
  else den *= 10n ** BigInt(-exp);
  return { num: m[1] ? -num : num, den };
}

/** Whether a float of `bits` bits (f16, f32, f64, f80, f128) holds the integer exactly. */
function floatHoldsInt(bits: number, n: bigint): boolean {
  const { significand, maxExponent } = { 16: { significand: 11, maxExponent: 15 }, 32: { significand: 24, maxExponent: 127 }, 64: { significand: 53, maxExponent: 1023 }, 80: { significand: 64, maxExponent: 16383 }, 128: { significand: 113, maxExponent: 16383 } }[bits as 16]!;
  let a = n < 0n ? -n : n;
  if (a === 0n) return true;
  if (a.toString(2).length > maxExponent + 1) return false;
  while ((a & 1n) === 0n) a >>= 1n;
  return a.toString(2).length <= significand;
}

const C_TYPES: Record<string, { c: CType; signed: boolean }> = {
  c_char: { c: 'char', signed: true },
  c_short: { c: 'short', signed: true },
  c_ushort: { c: 'ushort', signed: false },
  c_int: { c: 'int', signed: true },
  c_uint: { c: 'uint', signed: false },
  c_long: { c: 'long', signed: true },
  c_ulong: { c: 'ulong', signed: false },
  c_longlong: { c: 'longlong', signed: true },
  c_ulonglong: { c: 'ulonglong', signed: false },
};

/** The type as Zig writes it. */
export function formatType(t: ZType): string {
  switch (t.k) {
    case 'int':
      return `${t.signed ? 'i' : 'u'}${t.bits}`;
    case 'usize':
    case 'isize':
    case 'bool':
    case 'void':
    case 'noreturn':
    case 'anyopaque':
    case 'c_longdouble':
      return t.k;
    case 'c':
      return t.name;
    case 'float':
      return `f${t.bits}`;
    case 'comptime':
      return t.name;
    case 'ptr': {
      const mods = `${t.align !== undefined ? `align(${t.align}) ` : ''}${t.allowzero ? 'allowzero ' : ''}${t.isConst ? 'const ' : ''}${t.isVolatile ? 'volatile ' : ''}`;
      const head = t.size === 'one' ? '*' : t.size === 'many' ? (t.sentinel ? `[*:${t.sentinel}]` : '[*]') : t.size === 'c' ? '[*c]' : t.sentinel ? `[:${t.sentinel}]` : '[]';
      return `${head}${mods}${formatType(t.child)}`;
    }
    case 'array':
      return `[${t.len}${t.sentinel ? `:${t.sentinel}` : ''}]${formatType(t.child)}`;
    case 'vector':
      return `@Vector(${t.len}, ${formatType(t.child)})`;
    case 'opt':
      return `?${formatType(t.child)}`;
    case 'errset':
      return t.names === null ? 'anyerror' : `error{${t.names.join(',')}}`;
    case 'errunion':
      return `${formatType(t.set)}!${formatType(t.payload)}`;
    case 'fn':
      return t.text;
    case 'container':
      return t.c.name;
  }
}

/** Identity of a type, for `==` on types and memoizing calls. */
function typeKey(t: ZType): string {
  switch (t.k) {
    case 'container':
      return `#${t.c.id}`;
    case 'ptr':
      return `ptr(${t.size},${t.isConst},${t.isVolatile},${t.allowzero},${t.align ?? ''},${t.sentinel ?? ''},${typeKey(t.child)})`;
    case 'array':
      return `arr(${t.len},${t.sentinel ?? ''},${typeKey(t.child)})`;
    case 'vector':
      return `vec(${t.len},${typeKey(t.child)})`;
    case 'opt':
      return `opt(${typeKey(t.child)})`;
    case 'errunion':
      return `eu(${typeKey(t.set)},${typeKey(t.payload)})`;
    case 'fn':
      return t.key;
    default:
      return formatType(t);
  }
}

function valueKey(v: Value): string {
  switch (v.k) {
    case 'type':
      return `T:${typeKey(v.t)}`;
    case 'int':
      return `i:${v.v}`;
    case 'bool':
      return `b:${v.v}`;
    case 'enumLit':
      return `.${v.name}`;
    case 'enumValue':
      return `#${v.type.id}.${v.name}`;
    case 'string':
      return `s:${JSON.stringify(v.v)}`;
    case 'fn':
      return `fn#${v.id}`;
    case 'union':
      return `u:${v.tag}(${valueKey(v.payload)})`;
    case 'optional':
      return v.v === null ? 'null' : valueKey(v.v);
    default:
      return v.k;
  }
}

function describeValue(v: Value): string {
  switch (v.k) {
    case 'type':
      return `the type '${formatType(v.t)}'`;
    case 'int':
      return `the integer ${v.v}`;
    case 'bool':
      return `the bool ${v.v}`;
    case 'enumLit':
      return `the enum literal .${v.name}`;
    case 'fn':
      return `the function '${v.name}'`;
    case 'enumValue':
      return `${v.type.name}.${v.name}`;
    case 'union':
      return `a union with .${v.tag} active`;
    case 'optional':
      return v.v === null ? 'null' : `an optional holding ${describeValue(v.v)}`;
    case 'unmodelled':
      return `${v.what} (not modelled here)`;
    default:
      return v.k;
  }
}

/** A field's type as written; a container type written in place with its body elided. */
function fieldTypeText(source: string, f: FieldDecl): string {
  if (!f.type) return 'void';
  if (f.type.k === 'container') return `${source.slice(f.type.c.start, f.type.c.bodyStart).trim()} { ... }`;
  return source.slice(f.typeStart, f.typeEnd).replace(/\s+/g, ' ');
}

// ------------------------------------------------------------------ the engine

let containerIds = 0;
let fnIds = 0;

export interface ZigEngineOptions {
  mode: ZigBuildMode;
  /** `-mcpu`: an x86-64 level; the target's default when unset. */
  cpu?: string;
  /** `--error-limit`: how many error names the program may have; 65535 by default. */
  errorLimit?: number;
}

/** zig's default --error-limit: error codes are u16. */
export const DEFAULT_ERROR_LIMIT = 65535;

export class ZigEngine {
  private readonly ptrBytes: number;
  private readonly fileScope: Scope;
  private std?: Value;
  private readonly memo = new Map<string, Value>();
  private readonly fnIdsByDecl = new WeakMap<FnDecl, number>();
  private callDepth = 0;
  /** Every expression and type worked out inside another is one level deeper, a declaration's value included (nesting.ts). */
  private readonly nesting = new Nesting();
  /** Containers whose layout was computed, in the order they were reached. */
  readonly reached = new Set<Container>();
  /** The error names the evaluated code declares: the program's global error set. */
  private readonly errorNames = new Set<string>();

  constructor(
    readonly target: ZigTarget,
    readonly file: ZigFile,
    readonly options: ZigEngineOptions,
  ) {
    this.ptrBytes = ptrBits(target) / 8;
    const root = this.newContainer('root', file.root, undefined, file.source, false);
    this.fileScope = root.scope;
  }

  get rootScope(): Scope {
    return this.fileScope;
  }

  private readonly sources = new WeakMap<Container, string>();

  /** The same container with another layout or field order, in the same scope. */
  variant(c: Container, change: Partial<ContainerDecl>): Container {
    const decl: ContainerDecl = { ...c.decl, ...change };
    const fields = this.fieldsOf(c);
    const byName = new Map(fields.map((f) => [f.name, f]));
    const copy: Container = { id: c.id, name: c.name, decl, scope: c.scope, tuple: c.tuple };
    copy.fields = change.fields ? change.fields.map((f) => byName.get(f.name!)!) : fields;
    this.sources.set(copy, this.sourceOf(c));
    return copy;
  }

  private newContainer(name: string, decl: ContainerDecl, parent: Scope | undefined, source: string, prelude: boolean): Container {
    const tuple = decl.kind === 'struct' && decl.fields.length > 0 && decl.fields.every((f) => f.name === undefined);
    if (decl.kind === 'struct' && !tuple && decl.fields.some((f) => f.name === undefined)) {
      throw new ZigLayoutError('A struct cannot mix named fields and tuple fields.', decl.line);
    }
    const scope = new Scope(parent, prelude);
    const c: Container = { id: ++containerIds, name, decl, scope, tuple };
    scope.container = c;
    this.sources.set(c, source);
    for (const d of decl.decls) {
      if (scope.bindings.has(d.name)) throw new ZigLayoutError(`Redeclaration of '${d.name}'.`, d.line);
      scope.bindings.set(d.name, { k: 'decl', decl: d, scope });
    }
    return c;
  }

  sourceOf(c: Container): string {
    return this.sources.get(c) ?? this.file.source;
  }

  // ---------------------------------------------------------------- evaluation

  private stdValue(): Value {
    if (!this.std) {
      const file = parseZig(ZIG_STD);
      if (file.errors.length) throw new Error(`std prelude: ${file.errors[0]!.message} (line ${file.errors[0]!.line})`);
      const c = this.newContainer('std', file.root, undefined, ZIG_STD, true);
      this.std = { k: 'type', t: { k: 'container', c } };
    }
    return this.std;
  }

  /** The value a declaration binds, evaluated once. */
  private declValue(b: Extract<Binding, { k: 'decl' }>, line: number): Value {
    if (b.state === 'done') return b.v!;
    if (b.state === 'evaluating') throw new ZigLayoutError(`'${b.decl.name}' depends on itself.`, line);
    const d = b.decl;
    b.state = 'evaluating';
    try {
      let v: Value;
      if (d.kind === 'fn') {
        let id = this.fnIdsByDecl.get(d.fn!);
        if (id === undefined) {
          id = ++fnIds;
          this.fnIdsByDecl.set(d.fn!, id);
        }
        v = { k: 'fn', fn: d.fn!, scope: b.scope, name: d.name, id };
      } else if (d.kind === 'var') {
        throw new ZigLayoutError(`'${d.name}' is a var: its value is not known at compile time.`, line);
      } else {
        if (!d.value) throw new ZigLayoutError(`'${d.name}' has no value.`, d.line);
        const owner = b.scope.container;
        // A declared type is the value's result type, and the value is coerced to it.
        const type = d.type ? this.evalType(d.type, b.scope) : undefined;
        v = this.eval(d.value, b.scope, owner && owner.name !== 'root' ? `${owner.name}.${d.name}` : d.name, type);
        if (type) v = this.coerce(v, type, d.line);
      }
      b.v = v;
      b.state = 'done';
      return v;
    } catch (err) {
      b.state = undefined;
      throw err;
    }
  }

  private primitive(name: string): Value | undefined {
    const m = /^([iu])(\d+)$/.exec(name);
    if (m) {
      const bits = Number(m[2]);
      if (bits > 65535) return undefined;
      return { k: 'type', t: { k: 'int', signed: m[1] === 'i', bits } };
    }
    const c = C_TYPES[name];
    if (c) return { k: 'type', t: { k: 'c', c: c.c, signed: c.signed, name } };
    switch (name) {
      case 'usize':
      case 'isize':
        return { k: 'type', t: { k: name } };
      case 'f16':
      case 'f32':
      case 'f64':
      case 'f80':
      case 'f128':
        return { k: 'type', t: { k: 'float', bits: Number(name.slice(1)) as 16 | 32 | 64 | 80 | 128 } };
      case 'c_longdouble':
      case 'bool':
      case 'void':
      case 'noreturn':
      case 'anyopaque':
        return { k: 'type', t: { k: name } };
      case 'anyerror':
        return { k: 'type', t: { k: 'errset', names: null } };
      case 'type':
      case 'comptime_int':
      case 'comptime_float':
        return { k: 'type', t: { k: 'comptime', name } };
      case 'true':
        return { k: 'bool', v: true };
      case 'false':
        return { k: 'bool', v: false };
      case 'null':
        return { k: 'null' };
      case 'undefined':
        return { k: 'undefined' };
      default:
        return undefined;
    }
  }

  evalType(e: Expr, scope: Scope, nameHint?: string): ZType {
    const v = this.eval(e, scope, nameHint);
    if (v.k !== 'type') throw new ZigLayoutError(`Expected a type, found ${describeValue(v)}.`, e.line);
    return v.t;
  }

  /** An integer; with a result type, the value is coerced to it, as where the language gives one. */
  evalInt(e: Expr, scope: Scope, rt?: ZType): bigint {
    let v = this.eval(e, scope, undefined, rt);
    if (v.k === 'bool') throw new ZigLayoutError('Expected an integer, found a bool.', e.line);
    if (v.k !== 'int') throw new ZigLayoutError(`Expected an integer, found ${describeValue(v)}.`, e.line);
    if (rt) v = this.coerce(v, rt, e.line);
    return (v as Extract<Value, { k: 'int' }>).v;
  }

  private evalBool(e: Expr, scope: Scope): boolean {
    const v = this.eval(e, scope);
    if (v.k !== 'bool') throw new ZigLayoutError(`Expected a bool, found ${describeValue(v)}.`, e.line);
    return v.v;
  }

  /** A length or count, of the type the language gives it (an array length is a usize, a vector's a u32). */
  private evalCount(e: Expr, scope: Scope, what: string, rt?: ZType): number {
    const n = this.evalInt(e, scope, rt);
    if (n < 0n) throw new ZigLayoutError(`${what} cannot be negative (${n}).`, e.line);
    if (n > 0xffffffffn) throw new ZigLayoutError(`${what} ${n} is too large.`, e.line);
    return Number(n);
  }

  private evalAlign(e: Expr, scope: Scope): number {
    const n = this.evalCount(e, scope, 'An alignment');
    if (n === 0 || (n & (n - 1)) !== 0) throw new ZigLayoutError(`Alignment ${n} is not a power of two.`, e.line);
    return n;
  }

  /**
   * The value of an expression. `rt` is its result type where the language gives one (a declared
   * type, a parameter's, a return type, @as, an array length's usize, ...): the casts that take
   * their type from it (@intCast, @truncate, @enumFromInt, ...) need it, and it passes into the
   * branches of `if`, `switch` and `orelse`.
   */
  eval(e: Expr, scope: Scope, nameHint?: string, rt?: ZType): Value {
    return this.nesting.in(() => this.evalHere(e, scope, nameHint, rt), e.line);
  }

  private evalHere(e: Expr, scope: Scope, nameHint?: string, rt?: ZType): Value {
    switch (e.k) {
      case 'ident': {
        const p = this.primitive(e.name);
        if (p) return p;
        const b = scope.lookup(e.name);
        if (!b) throw new ZigLayoutError(`Use of undeclared identifier '${e.name}'.`, e.line);
        return b.k === 'value' ? b.v : this.declValue(b, e.line);
      }
      case 'int':
        return { k: 'int', v: e.v };
      case 'float':
        return { k: 'float', text: e.text };
      case 'string':
        return { k: 'string', v: e.v };
      case 'enumLit':
        return { k: 'enumLit', name: e.name };
      case 'init':
        return { k: 'init' };
      case 'errorSet': {
        // zig counts every error name the compilation uses against --error-limit; these
        // are the ones the definition uses, so the program as a whole has at least as many.
        for (const n of e.names) this.errorNames.add(n);
        if (this.errorNames.size > this.errorLimit) {
          throw new ZigLayoutError(`The definition uses ${this.errorNames.size} error names, more than --error-limit ${this.errorLimit} allows.`, e.line);
        }
        return { k: 'type', t: { k: 'errset', names: [...new Set(e.names)] } };
      }
      case 'errorValue':
        throw new ZigLayoutError(`error.${e.name} is a value, not a type.`, e.line);
      case 'comptime':
        return this.eval(e.e, scope, nameHint, rt);
      case 'unreachable':
        throw new ZigLayoutError('Reached unreachable code at compile time.', e.line);
      case 'switch': {
        const subject = this.eval(e.subject, scope);
        this.checkSwitch(e, subject, scope);
        const matches = (item: SwitchProng['items'][number]): boolean => {
          if ('value' in item) return this.equal(subject, this.switchItem(subject, item.value, scope), e.line);
          if (subject.k !== 'int') throw new ZigLayoutError('A range prong needs an integer to switch on.', e.line);
          return this.evalInt(item.from, scope) <= subject.v && subject.v <= this.evalInt(item.to, scope);
        };
        const prong = e.prongs.find((p) => !p.isElse && p.items.some(matches)) ?? e.prongs.find((p) => p.isElse);
        if (!prong) throw new ZigLayoutError(`No prong of the switch matches ${describeValue(subject)}, and there is no else.`, e.line);
        return this.eval(prong.body, scope, nameHint, rt);
      }
      case 'field':
        return this.fieldAccess(this.eval(e.obj, scope), e.name, e.line, scope);
      case 'call':
        return this.call(e, scope);
      case 'builtin':
        return this.builtin(e, scope, rt);
      case 'unary':
        return this.unary(e.op, this.eval(e.e, scope), e.line);
      case 'binary':
        return this.binary(e, scope, rt);
      case 'index':
        throw new ZigLayoutError('Indexing is not supported in a type expression.', e.line);
      case 'deref':
        throw new ZigLayoutError("'.*' (a pointer's value) is not supported in a type expression.", e.line);
      case 'unwrap': {
        // `x.?`: the payload; null is a compile error at compile time.
        const v = this.eval(e.e, scope);
        if (v.k !== 'optional') throw new ZigLayoutError(`'.?' needs an optional, not ${describeValue(v)}.`, e.line);
        if (v.v === null) throw new ZigLayoutError("Attempt to use a null value ('.?' of null).", e.line);
        return v.v;
      }
      case 'if': {
        const taken = this.condition(e.cond, e.capture, scope);
        if (taken) return this.eval(e.then, taken, nameHint, rt);
        if (!e.else) return { k: 'void' };
        return this.eval(e.else, scope, nameHint, rt);
      }
      case 'optional':
        return { k: 'type', t: { k: 'opt', child: this.evalType(e.child, scope) } };
      case 'errorUnion': {
        const set = this.evalType(e.set, scope);
        if (set.k !== 'errset') throw new ZigLayoutError(`Expected an error set before '!', found '${formatType(set)}'.`, e.line);
        return { k: 'type', t: { k: 'errunion', set, payload: this.evalType(e.payload, scope) } };
      }
      case 'pointer': {
        const child = this.evalType(e.child, scope);
        const t: ZType = {
          k: 'ptr',
          size: e.size,
          child,
          isConst: e.isConst,
          isVolatile: e.isVolatile,
          allowzero: e.allowzero,
          align: e.align ? this.evalAlign(e.align, scope) : undefined,
          sentinel: e.sentinel ? this.sentinelText(e.sentinel, child, scope) : undefined,
        };
        return { k: 'type', t };
      }
      case 'array': {
        if (e.len === 'infer') throw new ZigLayoutError("An array type's length must be given: [_]T is only for array literals.", e.line);
        const len = this.evalCount(e.len, scope, 'An array length', { k: 'usize' });
        const child = this.evalType(e.child, scope);
        // Sema.validateArrayElemType
        if (child.k === 'anyopaque' || (child.k === 'container' && child.c.decl.kind === 'opaque')) {
          throw new ZigLayoutError(`Array of opaque type '${formatType(child)}' not allowed.`, e.line);
        }
        if (child.k === 'noreturn') throw new ZigLayoutError("Array of 'noreturn' not allowed.", e.line);
        return { k: 'type', t: { k: 'array', len, child, sentinel: e.sentinel ? this.sentinelText(e.sentinel, child, scope) : undefined } };
      }
      case 'container': {
        const parentName = scope.nearestContainer();
        const name =
          nameHint ??
          (parentName && parentName.name !== 'root' ? `${parentName.name}.${e.c.kind}` : e.c.kind);
        const c = this.newContainer(name, e.c, scope, this.sourceFor(scope), scope.isPrelude);
        return { k: 'type', t: { k: 'container', c } };
      }
      case 'fnType': {
        const callconv = e.callconv ? this.callconvName(e.callconv, scope) : undefined;
        const params = e.params.map((p) => (p.type ? this.evalType(p.type, scope) : undefined));
        return { k: 'type', t: this.fnType(params, this.evalType(e.ret, scope), callconv) };
      }
    }
  }

  private sourceFor(scope: Scope): string {
    const c = scope.nearestContainer();
    return c ? this.sourceOf(c) : this.file.source;
  }

  private callconvName(e: Expr, scope: Scope): string {
    if (e.k === 'enumLit') return e.name;
    if (e.k === 'field' && e.obj.k === 'ident' && e.name) return e.name;
    const v = this.eval(e, scope);
    if (v.k === 'enumLit') return v.name;
    throw new ZigLayoutError('Unsupported calling convention.', e.line);
  }

  /**
   * A sentinel, as Sema.zirArrayTypeSentinel takes it: the value coerced to the element type, which
   * must be one whose values compare with `==` (Type.isSelfComparable): no plain structs, unions or
   * arrays ("non-scalar sentinel type"). Its text is how the type's name shows it.
   */
  private sentinelText(e: Expr, child: ZType, scope: Scope): string {
    const raw = this.eval(e, scope, undefined, child);
    // An anonymous literal `.{ ... }` coerces to an aggregate of its fields; the engine does not
    // hold them, so for it only the type is checked (and only a packed container could take it).
    const v = raw.k === 'init' ? raw : this.coerce(raw, child, e.line);
    if (!this.isSelfComparable(child)) throw new ZigLayoutError(`Non-scalar sentinel type '${formatType(child)}'.`, e.line);
    const text = (x: Value): string | undefined =>
      x.k === 'int'
        ? String(x.v)
        : x.k === 'bool'
          ? String(x.v)
          : x.k === 'float'
            ? this.floatText(x)
            : x.k === 'enumValue'
              ? `.${x.name}`
              : x.k === 'optional'
                ? x.v === null
                  ? 'null'
                  : text(x.v)
                : x.k === 'void'
                  ? '{}'
                  : undefined;
    const s = text(v);
    if (s === undefined) throw new ZigLayoutError(`A sentinel of ${describeValue(v)} is not modelled here.`, e.line);
    return s;
  }

  /**
   * A float value as zig prints it (the shortest text that reads back as the value): a value of
   * f32 or f64, or one any float type holds exactly. Others are not modelled.
   */
  private floatText(x: Extract<Value, { k: 'float' }>): string | undefined {
    const r = rationalOf(x.text);
    if (!r) return undefined;
    const d = Number(x.text.replace(/_/g, ''));
    const bits = x.type?.k === 'float' ? x.type.bits : x.type?.k === 'c_longdouble' ? cTypeBitSize(this.target, 'longdouble') : 128;
    const exact = Number.isFinite(d) && Number.isInteger(d) ? BigInt(d) * r.den === r.num : false;
    const value = bits === 32 ? Math.fround(d) : bits === 64 || exact ? d : undefined;
    return value === undefined ? undefined : String(value).replace('e+', 'e');
  }

  /** Type.isSelfComparable for `==`. */
  private isSelfComparable(t: ZType): boolean {
    switch (t.k) {
      case 'int':
      case 'usize':
      case 'isize':
      case 'c':
      case 'float':
      case 'c_longdouble':
      case 'bool':
      case 'void':
      case 'errset':
      case 'fn':
      case 'anyopaque':
        return true;
      case 'comptime':
        return t.name !== '@TypeOf(null)' && t.name !== '@TypeOf(undefined)';
      case 'vector':
        return this.isSelfComparable(t.child);
      case 'ptr':
        return t.size !== 'slice';
      case 'opt':
        return this.isSelfComparable(t.child);
      case 'container':
        return t.c.decl.kind === 'enum' || t.c.decl.kind === 'opaque' || t.c.decl.layout === 'packed';
      default:
        return false;
    }
  }

  /**
   * Whether an `if` takes its first branch, and the scope it runs in. With a capture (`|x|`), the
   * condition is an optional: null takes the other branch, a value is bound to the name.
   */
  private condition(cond: Expr, capture: string | undefined, scope: Scope): Scope | null {
    if (capture === undefined) return this.evalBool(cond, scope) ? scope : null;
    const v = this.eval(cond, scope);
    if (v.k === 'null' || (v.k === 'optional' && v.v === null)) return null;
    if (v.k !== 'optional') throw new ZigLayoutError(`A capture (|x|) needs an optional, not ${describeValue(v)}.`, cond.line);
    const inner = new Scope(scope);
    if (capture !== '_') inner.bindings.set(capture, { k: 'value', v: v.v! });
    return inner;
  }

  /**
   * `==` of comptime values. An enum literal is compared as a value of the other side's enum (one
   * of its fields: `==` gives it no result type, so no declaration counts), a tagged union with a
   * tag by its active field, an optional with null or its payload's type.
   */
  private equal(l: Value, r: Value, line: number): boolean {
    if (l.k === 'union' && r.k === 'enumLit') return l.tag === r.name;
    if (r.k === 'union' && l.k === 'enumLit') return r.tag === l.name;
    if (l.k === 'optional' || r.k === 'optional') {
      const unwrap = (v: Value) => (v.k === 'optional' ? v.v : v.k === 'null' ? null : v);
      const a = unwrap(l);
      const b = unwrap(r);
      return a === null || b === null ? a === b : this.equal(a, b, line);
    }
    if (l.k === 'enumValue' && r.k === 'enumLit') return valueKey(l) === valueKey(this.enumField(l.type, r.name, line));
    if (r.k === 'enumValue' && l.k === 'enumLit') return valueKey(r) === valueKey(this.enumField(r.type, l.name, line));
    return valueKey(l) === valueKey(r);
  }

  /** A switch prong's item, which takes the subject's type as its result type (so `.name` may be a decl literal). */
  private switchItem(subject: Value, item: Expr, scope: Scope): Value {
    const v = this.eval(item, scope);
    return subject.k === 'enumValue' && v.k === 'enumLit' ? this.coerce(v, { k: 'container', c: subject.type }, item.line) : v;
  }

  /**
   * A switch Zig compiles: at most one else, no value twice, and without else every value of the
   * subject's type handled (an enum's fields, both bools, a fixed-width integer's whole range).
   * Other types (comptime_int, type) have too many values to list, so they need an else.
   */
  private checkSwitch(e: Extract<Expr, { k: 'switch' }>, subject: Value, scope: Scope): void {
    const elses = e.prongs.filter((p) => p.isElse).length;
    if (elses > 1) throw new ZigLayoutError('A switch has more than one else prong.', e.line);
    const values: Value[] = [];
    const ranges: Array<[bigint, bigint]> = [];
    for (const p of e.prongs) {
      for (const item of p.items) {
        if ('value' in item) {
          const v = this.switchItem(subject, item.value, scope);
          if (values.some((x) => this.equal(x, v, e.line))) throw new ZigLayoutError(`Duplicate switch value: ${describeValue(v)}.`, e.line);
          values.push(v);
          if (v.k === 'int') ranges.push([v.v, v.v]);
        } else {
          const from = this.evalInt(item.from, scope);
          const to = this.evalInt(item.to, scope);
          if (from > to) throw new ZigLayoutError(`Empty switch range ${from}...${to}.`, e.line);
          ranges.push([from, to]);
        }
      }
    }
    const sorted = [...ranges].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k]![0] <= sorted[k - 1]![1]) throw new ZigLayoutError(`Duplicate switch value: ${sorted[k]![0]}.`, e.line);
    }
    if (elses > 0) return;
    const missing = (what: string) => new ZigLayoutError(`The switch does not handle every value: ${what}. Add the prongs, or an else.`, e.line);
    if (subject.k === 'enumValue') {
      const d = subject.type.decl;
      if (d.nonexhaustive) throw new ZigLayoutError(`A switch on the non-exhaustive enum '${subject.type.name}' needs an else prong.`, e.line);
      const handled = new Set(values.map((v) => (v.k === 'enumLit' || v.k === 'enumValue' ? v.name : '')));
      const left = d.fields.map((f) => f.name!).filter((n) => !handled.has(n));
      if (left.length) throw missing(left.map((n) => `.${n}`).join(', '));
      return;
    }
    if (subject.k === 'bool') {
      const left = [true, false].filter((b) => !values.some((v) => v.k === 'bool' && v.v === b));
      if (left.length) throw missing(left.join(', '));
      return;
    }
    if (subject.k === 'int' && subject.type) {
      const { min, max } = this.intRange(subject.type);
      let next = min;
      for (const [from, to] of sorted) {
        if (from > next) break;
        if (to >= next) next = to + 1n;
      }
      if (next <= max) throw missing(`${next} and maybe more`);
      return;
    }
    throw new ZigLayoutError(`A switch on ${describeValue(subject)} needs an else prong: its type has too many values to list.`, e.line);
  }

  /** A function type; `undefined` for an anytype parameter. */
  private fnType(params: readonly (ZType | undefined)[], ret: ZType, callconv?: string): Extract<ZType, { k: 'fn' }> {
    const cc = callconv ? ` callconv(.${callconv})` : '';
    const text = `fn (${params.map((p) => (p ? formatType(p) : 'anytype')).join(', ')})${cc} ${formatType(ret)}`;
    const key = `fn(${params.map((p) => (p ? typeKey(p) : 'anytype')).join(',')})${cc}${typeKey(ret)}`;
    return { k: 'fn', text, key, callconv };
  }

  /** A function's type: what coercing it to a function type compares. Generic functions have none. */
  private fnTypeOf(f: Extract<Value, { k: 'fn' }>, line: number): Extract<ZType, { k: 'fn' }> {
    if (f.fn.params.some((p) => p.comptime || !p.type)) {
      throw new ZigLayoutError(`'${f.name}' is generic (comptime or anytype parameters): it has no function type.`, line);
    }
    if (f.fn.inferredErrorSet) throw new ZigLayoutError(`'${f.name}' infers its error set (!T): it has no function type to coerce to.`, line);
    const scope = new Scope(f.scope);
    const params = f.fn.params.map((p) => this.evalType(p.type!, scope));
    const callconv = f.fn.callconv ? this.callconvName(f.fn.callconv, scope) : undefined;
    return this.fnType(params, this.evalType(f.fn.ret, scope), callconv);
  }

  /** The type of a comptime value, as @TypeOf gives it. */
  private typeOfValue(v: Value, line: number): ZType {
    const notModelled = (what: string) => new ZigLayoutError(`The type of ${what} is not modelled here.`, line);
    switch (v.k) {
      case 'type':
        return { k: 'comptime', name: 'type' };
      case 'int':
        return v.type ?? { k: 'comptime', name: 'comptime_int' };
      case 'float':
        return v.type ?? { k: 'comptime', name: 'comptime_float' };
      case 'bool':
        return { k: 'bool' };
      case 'void':
        return { k: 'void' };
      case 'enumLit':
        return { k: 'comptime', name: '@EnumLiteral()' };
      case 'enumValue':
        return { k: 'container', c: v.type };
      case 'null':
        return { k: 'comptime', name: '@TypeOf(null)' };
      case 'undefined':
        return { k: 'comptime', name: '@TypeOf(undefined)' };
      case 'string':
        // A string literal is a pointer to a constant, zero-terminated array of its bytes.
        return {
          k: 'ptr',
          size: 'one',
          isConst: true,
          isVolatile: false,
          allowzero: false,
          child: { k: 'array', len: utf8Length(v.v), sentinel: '0', child: { k: 'int', signed: false, bits: 8 } },
        };
      case 'fn':
        return this.fnTypeOf(v, line);
      case 'record':
      case 'union':
      case 'optional':
        if (v.type) return v.type;
        throw notModelled(describeValue(v));
      case 'init':
        throw notModelled('an anonymous literal .{ ... }');
      case 'unmodelled':
        throw notModelled(v.what);
    }
  }

  /**
   * Sema.resolvePeerTypes: the type values of these types meet in (@TypeOf of several arguments,
   * arithmetic's operands). Each peer picks a strategy (PeerResolveStrategy.select) and they merge
   * into one; ported for the types comptime values here have. Peers of a strategy the engine does
   * not resolve (pointers, arrays, error sets, ...) must be of one type.
   */
  private peerType(peers: readonly { type: ZType; value?: Value }[], line: number): ZType {
    type Strategy = 'unknown' | 'error_set' | 'error_union' | 'nullable' | 'optional' | 'array' | 'vector' | 'c_ptr' | 'ptr' | 'func' | 'enum_or_union' | 'comptime_int' | 'comptime_float' | 'fixed_int' | 'fixed_float' | 'tuple' | 'exact';
    const ORDER: Strategy[] = ['unknown', 'error_set', 'error_union', 'nullable', 'optional', 'array', 'vector', 'c_ptr', 'ptr', 'func', 'enum_or_union', 'comptime_int', 'comptime_float', 'fixed_int', 'fixed_float', 'tuple', 'exact'];
    const select = (t: ZType): Strategy => {
      switch (t.k) {
        case 'comptime':
          return t.name === 'type' ? 'exact' : t.name === '@TypeOf(undefined)' ? 'unknown' : t.name === '@TypeOf(null)' ? 'nullable' : t.name === '@EnumLiteral()' ? 'enum_or_union' : t.name;
        case 'void':
        case 'bool':
        case 'anyopaque':
          return 'exact';
        case 'noreturn':
          return 'unknown';
        case 'int':
        case 'usize':
        case 'isize':
        case 'c':
          return 'fixed_int';
        case 'float':
        case 'c_longdouble':
          return 'fixed_float';
        case 'ptr':
          return t.size === 'c' ? 'c_ptr' : 'ptr';
        case 'array':
          return 'array';
        case 'vector':
          return 'vector';
        case 'opt':
          return 'optional';
        case 'errset':
          return 'error_set';
        case 'errunion':
          return 'error_union';
        case 'fn':
          return 'func';
        case 'container':
          return t.c.decl.kind === 'enum' || t.c.decl.kind === 'union' ? 'enum_or_union' : t.c.decl.kind === 'opaque' ? 'exact' : t.c.tuple ? 'tuple' : 'exact';
      }
    };
    const merge = (a: Strategy, b: Strategy): Strategy => {
      const [s0, s1] = ORDER.indexOf(a) <= ORDER.indexOf(b) ? [a, b] : [b, a];
      switch (s0) {
        case 'unknown':
          return s1;
        case 'error_set':
          return s1 === 'error_set' ? 'error_set' : 'error_union';
        case 'error_union':
          return 'error_union';
        case 'nullable':
          return s1 === 'nullable' ? 'nullable' : s1 === 'c_ptr' ? 'c_ptr' : 'optional';
        case 'optional':
          return s1 === 'c_ptr' ? 'c_ptr' : 'optional';
        case 'array':
          return s1 === 'vector' ? 'vector' : 'array';
        case 'vector':
        case 'c_ptr':
        case 'ptr':
        case 'enum_or_union':
        case 'exact':
          return s0;
        case 'tuple':
          return s1 === 'exact' ? 'exact' : 'tuple';
        default:
          // func, comptime_int, comptime_float, fixed_int, fixed_float: the later strategy wins.
          return s1;
      }
    };
    const conflict = (a: ZType, b: ZType) => new ZigLayoutError(`Incompatible types: '${formatType(a)}' and '${formatType(b)}'.`, line);
    let s: Strategy = 'unknown';
    for (const p of peers) s = merge(s, select(p.type));
    let live = peers;
    if (s === 'unknown') s = 'exact';
    else live = peers.filter((p) => !(p.type.k === 'noreturn' || (p.type.k === 'comptime' && p.type.name === '@TypeOf(undefined)')));
    const first = live[0]!;
    const isComptime = (t: ZType, name: string) => t.k === 'comptime' && t.name === name;
    switch (s) {
      case 'nullable':
        for (const p of live) if (!isComptime(p.type, '@TypeOf(null)')) throw conflict(first.type, p.type);
        return first.type;
      case 'optional': {
        const inner = live
          .filter((p) => !isComptime(p.type, '@TypeOf(null)'))
          .map((p) => (p.type.k === 'opt' ? { type: p.type.child, value: p.value?.k === 'optional' ? (p.value.v ?? undefined) : undefined } : p));
        return { k: 'opt', child: this.peerType(inner, line) };
      }
      case 'enum_or_union': {
        let cur: ZType | undefined;
        for (const p of live) {
          const t = p.type;
          const kind = isComptime(t, '@EnumLiteral()') ? 'literal' : t.k === 'container' && t.c.decl.kind === 'enum' ? 'enum' : t.k === 'container' && t.c.decl.kind === 'union' ? 'union' : undefined;
          if (!kind) throw conflict(first.type, t);
          if (!cur || isComptime(cur, '@EnumLiteral()')) {
            cur = t;
            continue;
          }
          if (kind === 'literal') continue;
          const curUnion = cur.k === 'container' && cur.c.decl.kind === 'union';
          if (kind === 'enum') {
            const want = curUnion && cur.k === 'container' ? this.unionTagType(cur.c) : cur;
            if (typeKey(want) !== typeKey(t)) throw conflict(cur, t);
          } else if (curUnion) {
            if (typeKey(cur) !== typeKey(t)) throw conflict(cur, t);
          } else {
            if (t.k !== 'container' || typeKey(this.unionTagType(t.c)) !== typeKey(cur)) throw conflict(cur, t);
            cur = t;
          }
        }
        return cur!;
      }
      case 'comptime_int':
        for (const p of live) if (!isComptime(p.type, 'comptime_int')) throw conflict(first.type, p.type);
        return first.type;
      case 'comptime_float':
        for (const p of live) if (!isComptime(p.type, 'comptime_int') && !isComptime(p.type, 'comptime_float')) throw conflict(first.type, p.type);
        return { k: 'comptime', name: 'comptime_float' };
      case 'fixed_int': {
        // The widest unsigned and the widest signed peer, the first on a tie; the signed one if it
        // is wider, else (with comptime-known values, as these are) the unsigned one if wider, the
        // earlier on a tie.
        let unsigned: number | undefined;
        let signed: number | undefined;
        live.forEach((p, i) => {
          if (isComptime(p.type, 'comptime_int')) return;
          if (!this.isIntType(p.type)) throw conflict(first.type, p.type);
          const isSigned = this.intRange(p.type).min < 0n;
          const current = isSigned ? signed : unsigned;
          if (current === undefined || this.bitSize(p.type) > this.bitSize(live[current]!.type)) {
            if (isSigned) signed = i;
            else unsigned = i;
          }
        });
        if (signed === undefined) return live[unsigned!]!.type;
        if (unsigned === undefined) return live[signed]!.type;
        const sBits = this.bitSize(live[signed]!.type);
        const uBits = this.bitSize(live[unsigned]!.type);
        return live[sBits > uBits ? signed : uBits > sBits ? unsigned : Math.min(signed, unsigned)]!.type;
      }
      case 'fixed_float': {
        let cur: ZType | undefined;
        for (const p of live) {
          const t = p.type;
          if (isComptime(t, 'comptime_int') || isComptime(t, 'comptime_float') || this.isIntType(t)) continue;
          if (t.k !== 'float' && t.k !== 'c_longdouble') throw conflict(first.type, t);
          if (!cur || typeKey(cur) === typeKey(t)) cur = cur ?? t;
          else cur = { k: 'float', bits: Math.max(this.bitSize(cur), this.bitSize(t)) as 16 | 32 | 64 | 80 | 128 };
        }
        return cur!;
      }
      default:
        // exact, and the strategies not ported: one type for all.
        for (const p of live) {
          if (typeKey(p.type) === typeKey(first.type)) continue;
          if (s === 'exact') throw conflict(first.type, p.type);
          throw new ZigLayoutError(`Peer type resolution of '${formatType(first.type)}' and '${formatType(p.type)}' is not modelled here.`, line);
        }
        return first.type;
    }
  }

  /**
   * The type integer operands of arithmetic meet in: their peer type, which each comptime-known
   * operand must fit (the coercion that follows); undefined for comptime_int.
   */
  private peerIntType(operands: readonly Extract<Value, { k: 'int' }>[], line: number): ZType | undefined {
    const t = this.peerType(operands.map((v) => ({ type: this.typeOfValue(v, line), value: v })), line);
    if (t.k === 'comptime') return undefined;
    for (const v of operands) this.coerce(v, t, line);
    return t;
  }

  /** std.math.Log2Int of a fixed-width integer type: what a shift amount coerces to. */
  private log2IntType(t: ZType, line: number): ZType {
    const bits = this.bitSize(t, line);
    return { k: 'int', signed: false, bits: smallestUnsignedBits(bits - 1) };
  }

  /** Type.intFittingRange of one value: the smallest integer type that holds it. */
  private intFitting(v: bigint): ZType {
    const bitLength = (n: bigint) => (n === 0n ? 0 : n.toString(2).length);
    return v < 0n ? { k: 'int', signed: true, bits: bitLength(-v - 1n) + 1 } : { k: 'int', signed: false, bits: bitLength(v) };
  }

  private isIntType(t: ZType): boolean {
    return t.k === 'int' || t.k === 'usize' || t.k === 'isize' || t.k === 'c';
  }

  /**
   * A value given a type, as a declaration, parameter or @as does: Zig's coercion of comptime-known
   * values. A value it does not coerce is an error, as for the compiler.
   */
  private coerce(v: Value, t: ZType, line: number): Value {
    const mismatch = () => new ZigLayoutError(`Expected a value of type '${formatType(t)}', found ${describeValue(v)}.`, line);
    if (this.isIntType(t)) {
      // A comptime-known integer coerces to any integer type that holds it; a float, when it is whole.
      let n: bigint;
      if (v.k === 'int') n = v.v;
      else if (v.k === 'float') {
        const r = rationalOf(v.text);
        if (!r) throw new ZigLayoutError(`The float ${v.text} is not modelled here.`, line);
        if (r.num % r.den !== 0n) throw new ZigLayoutError(`Fractional component prevents float value '${v.text}' from coercion to type '${formatType(t)}'.`, line);
        n = r.num / r.den;
      } else throw mismatch();
      const { min, max } = this.intRange(t);
      if (n < min || n > max) throw new ZigLayoutError(`Type '${formatType(t)}' cannot represent integer value '${n}'.`, line);
      return { k: 'int', v: n, type: t };
    }
    if (t.k === 'float' || t.k === 'c_longdouble') {
      // A float coerces to any float type (rounding); a comptime-known integer only to one that
      // holds it exactly.
      if (v.k === 'float') return { k: 'float', text: v.text, type: t };
      if (v.k !== 'int') throw mismatch();
      const bits = t.k === 'float' ? t.bits : cTypeBitSize(this.target, 'longdouble');
      if (!floatHoldsInt(bits, v.v)) throw new ZigLayoutError(`Type '${formatType(t)}' cannot represent integer value '${v.v}'.`, line);
      return { k: 'float', text: String(v.v), type: t };
    }
    switch (t.k) {
      case 'opt':
        if (v.k === 'null') return { k: 'optional', v: null, type: t };
        if (v.k === 'optional') return { k: 'optional', v: v.v === null ? null : this.coerce(v.v, t.child, line), type: t };
        return { k: 'optional', v: this.coerce(v, t.child, line), type: t };
      case 'comptime':
        if (t.name === 'type' && v.k === 'type') return v;
        if (t.name === 'comptime_int' && v.k === 'int') return { k: 'int', v: v.v };
        if (t.name === 'comptime_float' && (v.k === 'float' || v.k === 'int')) return v;
        if (t.name === '@EnumLiteral()' && v.k === 'enumLit') return v;
        throw mismatch();
      case 'bool':
        if (v.k === 'bool') return v;
        throw mismatch();
      case 'void':
        if (v.k === 'void') return v;
        throw mismatch();
      case 'fn': {
        if (v.k !== 'fn') throw mismatch();
        const own = this.fnTypeOf(v, line);
        if (own.key !== t.key) throw new ZigLayoutError(`Expected type '${t.text}', found '${own.text}'.`, line);
        return v;
      }
      case 'ptr':
        // A string literal coerces to []const u8, [:0]const u8 and [*:0]const u8.
        if (v.k === 'string' && t.isConst && t.child.k === 'int' && t.child.bits === 8 && !t.child.signed) return v;
        throw mismatch();
      case 'container': {
        const d = t.c.decl;
        // A decl literal: `.name` with a result type that has no such field is its declaration.
        if (v.k === 'enumLit' && !(d.kind === 'enum' && this.hasEnumField(t.c, v.name))) {
          const b = t.c.scope.bindings.get(v.name);
          if (b) return this.coerce(b.k === 'value' ? b.v : this.declValue(b, line), t, line);
        }
        if (d.kind === 'enum') {
          if (v.k === 'enumValue' && v.type.id === t.c.id) return v;
          if (v.k === 'enumLit') return this.enumField(t.c, v.name, line);
          throw mismatch();
        }
        // std.builtin.Type, which @typeInfo gives.
        if ((d.kind === 'union' && v.k === 'union') || (d.kind === 'struct' && v.k === 'record')) {
          if (v.type && typeKey(v.type) !== typeKey(t)) throw new ZigLayoutError(`Expected type '${formatType(t)}', found '${formatType(v.type)}'.`, line);
          return { ...v, type: t };
        }
        throw mismatch();
      }
      default:
        throw mismatch();
    }
  }

  private hasEnumField(c: Container, name: string): boolean {
    return c.decl.kind === 'enum' && name !== '_' && c.decl.fields.some((f) => f.name === name);
  }

  /** An enum literal as a value of the enum: one of its fields (declarations do not count). */
  private enumField(c: Container, name: string, line: number): Value {
    if (!this.hasEnumField(c, name)) throw new ZigLayoutError(`No field named '${name}' in enum '${c.name}'.`, line);
    return { k: 'enumValue', type: c, name };
  }

  /**
   * Sema.resolveDestType: a cast builtin's destination is its result type, without an error union
   * or optional around it; without a result type it has none.
   */
  private castDest(name: string, rt: ZType | undefined, line: number): ZType {
    if (!rt) throw new ZigLayoutError(`${name} must have a known result type: use @as to provide one.`, line);
    let t = rt;
    if (t.k === 'errunion') t = t.payload;
    if (t.k === 'opt') t = t.child;
    return t;
  }

  private isIntOrComptimeInt(t: ZType): boolean {
    return this.isIntType(t) || (t.k === 'comptime' && t.name === 'comptime_int');
  }

  /** An enum value's integer, of the enum's tag type. */
  private enumInt(v: Extract<Value, { k: 'enumValue' }>): Extract<Value, { k: 'int' }> {
    const info = this.enumInfo(v.type);
    const index = v.type.decl.fields.filter((f) => f.name !== '_').findIndex((f) => f.name === v.name);
    return { k: 'int', v: info.values[index]!, type: info.tag };
  }

  /** @truncate: the low bits of `n` as type `t`. */
  private truncate(n: bigint, t: ZType, line: number): Value {
    if (!this.isIntType(t)) throw new ZigLayoutError(`@truncate gives an integer, not '${formatType(t)}'.`, line);
    const bits = this.bitSize(t, line);
    const signed = t.k === 'int' ? t.signed : t.k === 'isize' ? true : t.k === 'c' ? t.signed : false;
    return { k: 'int', v: signed ? BigInt.asIntN(bits, n) : BigInt.asUintN(bits, n), type: t };
  }

  /**
   * The result of integer arithmetic of type `t` (or comptime_int): wrapping (`+%`) and saturating
   * (`+|`) operators keep it in range; for the others, going out of range is a compile error.
   */
  private intResult(v: bigint, t: ZType | undefined, op: string, line: number): Value {
    if (!t) return { k: 'int', v };
    const { min, max } = this.intRange(t);
    if (op === '+%' || op === '-%' || op === '*%') return this.truncate(v, t, line);
    if (op === '+|' || op === '-|' || op === '*|' || op === '<<|') return { k: 'int', v: v < min ? min : v > max ? max : v, type: t };
    if (v < min || v > max) throw new ZigLayoutError(`Overflow of integer type '${formatType(t)}' with value '${v}' ('${op}').`, line);
    return { k: 'int', v, type: t };
  }

  private isSignedInt(t: ZType): boolean {
    return t.k === 'int' ? t.signed : t.k === 'isize' ? true : t.k === 'c' ? t.signed : false;
  }

  /**
   * Sema.zirNegate (`-`: of a signed integer or comptime_int, never of an unsigned one), zirNegateWrap
   * (`-%`: of any integer, wrapping), and `~` (of a fixed-width integer: comptime_int has no width).
   */
  private unary(op: string, v: Value, line: number): Value {
    switch (op) {
      case '!':
        if (v.k !== 'bool') throw new ZigLayoutError(`'!' needs a bool, found ${describeValue(v)}.`, line);
        return { k: 'bool', v: !v.v };
      case '-':
      case '-%':
        if (v.k !== 'int') throw new ZigLayoutError(`Negation of ${describeValue(v)} is not supported here.`, line);
        if (op === '-' && v.type && !this.isSignedInt(v.type)) throw new ZigLayoutError(`Negation of type '${formatType(v.type)}': it is unsigned (use -% to wrap).`, line);
        return this.intResult(-v.v, v.type, op, line);
      case '~':
        if (v.k !== 'int') throw new ZigLayoutError(`'~' needs an integer, found ${describeValue(v)}.`, line);
        if (!v.type) throw new ZigLayoutError("Bitwise not operation on type 'comptime_int': give the integer a width, e.g. ~@as(u8, x).", line);
        // The bits flip within the integer's width.
        return this.truncate(~v.v, v.type, line);
      default:
        throw new ZigLayoutError(`'${op}' is not supported in a type expression.`, line);
    }
  }

  /**
   * A shift (Sema.zirShl, zirShr). For `<<` and `>>` the amount takes std.math.Log2Int of a
   * fixed-width left operand as its type (comptime_int for a comptime_int one), and must be less
   * than its width; `<<` drops the bits shifted out. `<<|` takes an amount of any integer type and
   * saturates. A comptime_int is shifted exactly; no amount may be negative.
   */
  private shift(e: Extract<Expr, { k: 'binary' }>, l: Extract<Value, { k: 'int' }>, scope: Scope): Value {
    const { op, line } = e;
    const t = l.type;
    let r = this.eval(e.r, scope, undefined, op === '<<|' ? undefined : t ? this.log2IntType(t, line) : { k: 'comptime', name: 'comptime_int' });
    if (r.k !== 'int') throw new ZigLayoutError(`Expected integer type, found '${formatType(this.typeOfValue(r, line))}'.`, line);
    if (op !== '<<|' && t) r = this.coerce(r, this.log2IntType(t, line), line) as Extract<Value, { k: 'int' }>;
    const b = r.v;
    if (b === 0n) return l;
    if (b < 0n) throw new ZigLayoutError(`Shift by negative amount '${b}'.`, line);
    if (!t) return { k: 'int', v: op === '>>' ? l.v >> b : l.v << b };
    const bits = BigInt(this.bitSize(t, line));
    if (op !== '<<|' && b >= bits) throw new ZigLayoutError(`Shift amount '${b}' is too large for operand type '${formatType(t)}'.`, line);
    if (op === '>>') return { k: 'int', v: l.v >> b, type: t };
    if (op === '<<') return this.truncate(l.v << b, t, line);
    // Saturating: any non-zero value shifted by the width or more is out of range.
    return this.intResult(l.v === 0n ? 0n : l.v << (b > bits ? bits : b), t, '<<|', line);
  }

  private binary(e: Extract<Expr, { k: 'binary' }>, scope: Scope, rt?: ZType): Value {
    const { op, line } = e;
    if (op === 'and' || op === 'or') {
      const l = this.evalBool(e.l, scope);
      if (op === 'and' ? !l : l) return { k: 'bool', v: l };
      return { k: 'bool', v: this.evalBool(e.r, scope) };
    }
    if (op === 'orelse') {
      // The payload of an optional, or (for null) the right side, which has the result type.
      const v = this.eval(e.l, scope);
      if (v.k === 'null' || (v.k === 'optional' && v.v === null)) return this.eval(e.r, scope, undefined, rt);
      if (v.k !== 'optional') throw new ZigLayoutError(`Expected optional type, found '${formatType(this.typeOfValue(v, line))}'.`, line);
      return v.v!;
    }
    if (op === 'catch') throw new ZigLayoutError("'catch' is not supported in a type expression: error unions have no values here.", line);
    const l = this.eval(e.l, scope);
    if ((op === '<<' || op === '<<|' || op === '>>') && l.k === 'int') return this.shift(e, l, scope);
    const r = this.eval(e.r, scope);
    if (op === '==' || op === '!=') {
      const eq = this.equal(l, r, line);
      return { k: 'bool', v: op === '==' ? eq : !eq };
    }
    if (op === '++') {
      if (l.k === 'string' && r.k === 'string') return { k: 'string', v: l.v + r.v };
      throw new ZigLayoutError("'++' is supported for strings here.", line);
    }
    if (op === '||') {
      if (l.k === 'type' && r.k === 'type' && l.t.k === 'errset' && r.t.k === 'errset') {
        if (l.t.names === null || r.t.names === null) return { k: 'type', t: { k: 'errset', names: null } };
        return { k: 'type', t: { k: 'errset', names: [...new Set([...l.t.names, ...r.t.names])] } };
      }
      throw new ZigLayoutError("'||' merges error sets.", line);
    }
    if (l.k !== 'int' || r.k !== 'int') {
      throw new ZigLayoutError(`'${op}' needs integers, found ${describeValue(l.k !== 'int' ? l : r)}.`, line);
    }
    const a = l.v;
    const b = r.v;
    const isComparison = op === '<' || op === '>' || op === '<=' || op === '>=';
    // Arithmetic has the operands' peer type.
    const peer = isComparison ? undefined : this.peerIntType([l, r], line);
    const result = (v: bigint) => this.intResult(v, peer, op, line);
    switch (op) {
      case '<':
        return { k: 'bool', v: a < b };
      case '>':
        return { k: 'bool', v: a > b };
      case '<=':
        return { k: 'bool', v: a <= b };
      case '>=':
        return { k: 'bool', v: a >= b };
      case '+':
      case '+%':
      case '+|':
        return result(a + b);
      case '-':
      case '-%':
      case '-|':
        return result(a - b);
      case '*':
      case '*%':
      case '*|':
        return result(a * b);
      case '/':
        if (b === 0n) throw new ZigLayoutError('Division by zero.', line);
        if (a < 0n || b < 0n) throw new ZigLayoutError('Division of signed integers must use @divTrunc, @divFloor or @divExact.', line);
        return result(a / b);
      case '%':
        if (b === 0n) throw new ZigLayoutError('Division by zero.', line);
        if (a < 0n || b < 0n) throw new ZigLayoutError('Remainder of signed integers must use @rem or @mod.', line);
        return result(a % b);
      case '&':
        return result(a & b);
      case '|':
        return result(a | b);
      case '^':
        return result(a ^ b);
      default:
        throw new ZigLayoutError(`'${op}' is not supported in a type expression.`, line);
    }
  }

  /** `a.b`: a declaration of a type (namespace), an enum field, or a field of a record value. */
  private fieldAccess(v: Value, name: string, line: number, from: Scope): Value {
    if (v.k === 'type') {
      if (v.t.k === 'container') {
        const c = v.t.c;
        const b = c.scope.bindings.get(name);
        if (b) {
          // Another file's declarations must be pub: std's, from the user's code.
          if (b.k === 'decl' && !b.decl.pub && c.scope.isPrelude && !from.isPrelude) {
            throw new ZigLayoutError(`'${name}' is not marked 'pub' in '${c.name}'.`, line);
          }
          return b.k === 'value' ? b.v : this.declValue(b, line);
        }
        if (c.decl.kind === 'enum' && c.decl.fields.some((f) => f.name === name)) return { k: 'enumValue', type: c, name };
        throw new ZigLayoutError(`'${c.name}' has no declaration named '${name}'.`, line);
      }
      if (v.t.k === 'errset') throw new ZigLayoutError(`${formatType(v.t)}.${name} is a value, not a type.`, line);
      throw new ZigLayoutError(`Type '${formatType(v.t)}' has no members.`, line);
    }
    if (v.k === 'record') {
      const f = v.fields.get(name);
      if (f) return f;
      throw new ZigLayoutError(`No field named '${name}'.`, line);
    }
    if (v.k === 'union') {
      if (name === v.tag) return v.payload;
      throw new ZigLayoutError(`Access of union field '${name}' while field '${v.tag}' is active.`, line);
    }
    if (v.k === 'optional') throw new ZigLayoutError(`'.${name}' of an optional: unwrap it first (.? or if (x) |v|).`, line);
    if (v.k === 'unmodelled') throw new ZigLayoutError(`${v.what} is not modelled here.`, line);
    throw new ZigLayoutError(`Cannot access '.${name}' of ${describeValue(v)}.`, line);
  }

  private call(e: Extract<Expr, { k: 'call' }>, scope: Scope): Value {
    // `value.method(...)`: a function of the value's type, with the value first.
    let callee: Value;
    const receiver = e.fn.k === 'field' ? this.eval(e.fn.obj, scope) : undefined;
    const method = e.fn.k === 'field' && receiver?.k === 'enumValue';
    if (method && e.fn.k === 'field' && receiver?.k === 'enumValue') {
      const b = receiver.type.scope.bindings.get(e.fn.name);
      if (!b) throw new ZigLayoutError(`'${receiver.type.name}' has no method named '${e.fn.name}'.`, e.line);
      callee = b.k === 'value' ? b.v : this.declValue(b, e.line);
    } else {
      callee = receiver && e.fn.k === 'field' ? this.fieldAccess(receiver, e.fn.name, e.line, scope) : this.eval(e.fn, scope);
    }
    if (callee.k !== 'fn') throw new ZigLayoutError(`Only a function can be called, not ${describeValue(callee)}.`, e.line);
    const fn = callee.fn;
    if (fn.body === null) throw new ZigLayoutError(`'${callee.name}' is an extern function: it cannot be called at compile time.`, e.line);
    if (fn.unsupported) throw new ZigLayoutError(`'${callee.name}' cannot be evaluated here: ${fn.unsupported}`, e.line);
    const argExprs: (Expr | Value)[] = method ? [receiver!, ...e.args] : e.args;
    if (argExprs.length !== fn.params.length) {
      throw new ZigLayoutError(`'${callee.name}' takes ${fn.params.length} argument${fn.params.length === 1 ? '' : 's'}, given ${argExprs.length}.`, e.line);
    }

    // Each argument has its parameter's type as its result type, and is coerced to it; the type
    // may name the parameters before it.
    const callScope = new Scope(callee.scope);
    const args: Value[] = [];
    fn.params.forEach((p, i) => {
      const type = p.type ? this.evalType(p.type, callScope) : undefined;
      const a = argExprs[i]!;
      let v = i === 0 && method ? (a as Value) : this.eval(a as Expr, scope, undefined, type);
      if (type) v = this.coerce(v, type, e.line);
      args.push(v);
      if (p.name && p.name !== '_') callScope.bindings.set(p.name, { k: 'value', v });
    });
    const key = `${callee.id}(${args.map(valueKey).join(',')})`;
    const cached = this.memo.get(key);
    if (cached) return cached;
    if (this.callDepth > 64) throw new ZigLayoutError(`Evaluation of '${callee.name}' recurses too deeply.`, e.line);

    const name = `${callee.name}(${args.map((a) => this.argText(a)).join(', ')})`;
    // The return type is resolved before the body runs: what `return` coerces its value to.
    const ret = this.evalType(fn.ret, callScope);
    this.callDepth += 1;
    try {
      let result = this.runBody(fn.body, callScope, name, ret);
      if (!result) {
        // A function returning void ends without a return.
        if (ret.k !== 'void') throw new ZigLayoutError(`'${callee.name}' returned no value.`, e.line);
        result = { k: 'void' };
      }
      this.memo.set(key, result);
      return result;
    } finally {
      this.callDepth -= 1;
    }
  }

  private argText(v: Value): string {
    switch (v.k) {
      case 'type':
        return formatType(v.t);
      case 'int':
        return String(v.v);
      case 'bool':
        return String(v.v);
      case 'enumLit':
        return `.${v.name}`;
      case 'string':
        return JSON.stringify(v.v);
      default:
        return v.k;
    }
  }

  /** Run statements; the value of the first `return` reached, coerced to the return type. */
  private runBody(body: Stmt[], scope: Scope, nameHint: string, ret: ZType): Value | undefined {
    for (const s of body) {
      switch (s.k) {
        case 'decl': {
          const d = s.decl;
          if (d.kind !== 'const') throw new ZigLayoutError(`'var' is not supported in a function that returns a type.`, d.line);
          if (scope.lookup(d.name) && scope.bindings.has(d.name)) throw new ZigLayoutError(`Redeclaration of '${d.name}'.`, d.line);
          const type = d.type ? this.evalType(d.type, scope) : undefined;
          const value = this.eval(d.value!, scope, d.name === 'Self' ? nameHint : `${nameHint}.${d.name}`, type);
          scope.bindings.set(d.name, { k: 'value', v: type ? this.coerce(value, type, d.line) : value });
          break;
        }
        case 'return':
          return s.e ? this.coerce(this.eval(s.e, scope, nameHint, ret), ret, s.e.line) : { k: 'void' };
        case 'if': {
          const taken = this.condition(s.cond, s.capture, scope);
          const branch = taken ? s.then : s.else;
          if (branch) {
            const r = this.runBody([branch], taken ?? new Scope(scope), nameHint, ret);
            if (r) return r;
          }
          break;
        }
        case 'block': {
          const r = this.runBody(s.body, new Scope(scope), nameHint, ret);
          if (r) return r;
          break;
        }
        case 'expr':
          // Evaluated for what it does at compile time: @compileError, a failing assertion.
          this.eval(s.e, scope);
          break;
        case 'assign':
          throw new ZigLayoutError('Assignment (a var changing at compile time) is not supported here: only constants.', s.line);
      }
    }
    return undefined;
  }

  private builtin(e: Extract<Expr, { k: 'builtin' }>, scope: Scope, rt?: ZType): Value {
    const args = e.args;
    const want = (n: number) => {
      if (args.length !== n) throw new ZigLayoutError(`${e.name} takes ${n} argument${n === 1 ? '' : 's'}.`, e.line);
    };
    const intArg = (i: number): Extract<Value, { k: 'int' }> => {
      const v = this.eval(args[i]!, scope);
      if (v.k !== 'int') throw new ZigLayoutError(`${e.name} needs integers, found ${describeValue(v)}.`, e.line);
      return v;
    };
    switch (e.name) {
      case '@import': {
        want(1);
        const v = this.eval(args[0]!, scope);
        if (v.k === 'string' && v.v === 'std') return this.stdValue();
        if (v.k === 'string' && v.v === 'builtin') return this.builtinModule();
        throw new ZigLayoutError(`Only @import("std") and @import("builtin") are available here${v.k === 'string' ? `, not "${v.v}"` : ''}.`, e.line);
      }
      case '@This': {
        want(0);
        const c = scope.nearestContainer();
        if (!c) throw new ZigLayoutError('@This() outside a container.', e.line);
        return { k: 'type', t: { k: 'container', c } };
      }
      case '@sizeOf':
      case '@alignOf':
      case '@bitSizeOf': {
        want(1);
        const t = this.evalType(args[0]!, scope);
        if (e.name === '@bitSizeOf') return { k: 'int', v: BigInt(this.bitSize(t, e.line)) };
        // Sema.zirSizeOf and zirAlignOf: no size for a type without values or a comptime-only
        // one; no alignment for a type without values.
        const cls = this.classify(t, e.line);
        if (cls === 'npv') throw new ZigLayoutError(`No ${e.name === '@sizeOf' ? 'size' : 'align'} available for uninstantiable type '${formatType(t)}'.`, e.line);
        if (e.name === '@sizeOf' && (cls === 'comptime' || cls === 'partial')) throw new ZigLayoutError(`No size available for comptime-only type '${formatType(t)}'.`, e.line);
        const l = this.layoutOf(t, e.line);
        return { k: 'int', v: BigInt(e.name === '@sizeOf' ? l.size : l.align) };
      }
      case '@offsetOf':
      case '@bitOffsetOf': {
        want(2);
        const t = this.evalType(args[0]!, scope);
        const nameV = this.eval(args[1]!, scope);
        if (nameV.k !== 'string') throw new ZigLayoutError(`${e.name} takes a field name string.`, e.line);
        return { k: 'int', v: BigInt(this.offsetOf(t, nameV.v, e.name === '@bitOffsetOf', e.line)) };
      }
      case '@Vector': {
        want(2);
        const len = this.evalCount(args[0]!, scope, 'A vector length', { k: 'int', signed: false, bits: 32 });
        const child = this.evalType(args[1]!, scope);
        if (!(child.k === 'int' || child.k === 'usize' || child.k === 'isize' || child.k === 'c' || child.k === 'float' || child.k === 'c_longdouble' || child.k === 'bool' || (child.k === 'ptr' && child.size !== 'slice'))) {
          throw new ZigLayoutError(`Vector element type must be an integer, float, bool or pointer, not '${formatType(child)}'.`, e.line);
        }
        return { k: 'type', t: { k: 'vector', len, child } };
      }
      case '@Int': {
        want(2);
        const s = this.eval(args[0]!, scope);
        // std.builtin.Signedness, as a value or a literal.
        if ((s.k !== 'enumLit' && s.k !== 'enumValue') || (s.name !== 'signed' && s.name !== 'unsigned')) throw new ZigLayoutError('@Int takes .signed or .unsigned.', e.line);
        const bits = this.evalCount(args[1]!, scope, 'A bit count', { k: 'int', signed: false, bits: 16 });
        return { k: 'type', t: { k: 'int', signed: s.name === 'signed', bits } };
      }
      case '@typeInfo': {
        want(1);
        return this.typeInfo(this.evalType(args[0]!, scope));
      }
      case '@typeName': {
        want(1);
        return { k: 'string', v: formatType(this.evalType(args[0]!, scope)) };
      }
      case '@setEvalBranchQuota':
        // A limit on comptime work, which only loops use up.
        want(1);
        this.evalInt(args[0]!, scope);
        return { k: 'void' };
      case '@FieldType': {
        want(2);
        const t = this.evalType(args[0]!, scope);
        const nameV = this.eval(args[1]!, scope);
        if (nameV.k !== 'string') throw new ZigLayoutError('@FieldType takes a field name string.', e.line);
        if (t.k !== 'container') throw new ZigLayoutError(`'${formatType(t)}' has no fields.`, e.line);
        const f = this.fieldsOf(t.c).find((x) => x.name === nameV.v);
        if (!f) throw new ZigLayoutError(`'${t.c.name}' has no field named '${nameV.v}'.`, e.line);
        return { k: 'type', t: f.type };
      }
      case '@TypeOf': {
        // The value's type; of several, their peer type.
        if (args.length === 0) throw new ZigLayoutError('@TypeOf takes at least 1 argument.', e.line);
        const vs = args.map((a) => this.eval(a, scope));
        if (vs.length === 1) return { k: 'type', t: this.typeOfValue(vs[0]!, e.line) };
        return { k: 'type', t: this.peerType(vs.map((v) => ({ type: this.typeOfValue(v, e.line), value: v })), e.line) };
      }
      case '@EnumLiteral':
        want(0);
        return { k: 'type', t: { k: 'comptime', name: '@EnumLiteral()' } };
      case '@as': {
        want(2);
        const t = this.evalType(args[0]!, scope);
        return this.coerce(this.eval(args[1]!, scope, undefined, t), t, e.line);
      }
      case '@intCast': {
        // Sema.intCast: a comptime-known integer coerces to the destination integer type.
        want(1);
        const dest = this.castDest(e.name, rt, e.line);
        const v = this.eval(args[0]!, scope);
        if (!this.isIntOrComptimeInt(dest)) throw new ZigLayoutError(`Expected integer or vector, found '${formatType(dest)}'.`, e.line);
        if (v.k !== 'int') throw new ZigLayoutError(`Expected integer or vector, found '${formatType(this.typeOfValue(v, e.line))}'.`, e.line);
        return dest.k === 'comptime' ? { k: 'int', v: v.v } : this.coerce(v, dest, e.line);
      }
      case '@truncate': {
        // Sema.zirTruncate: the low bits, of the same signedness; a wider destination is a coercion.
        want(1);
        const dest = this.castDest(e.name, rt, e.line);
        const v = this.eval(args[0]!, scope);
        if (!this.isIntOrComptimeInt(dest)) throw new ZigLayoutError(`Expected integer or vector, found '${formatType(dest)}'.`, e.line);
        if (v.k !== 'int') throw new ZigLayoutError(`Expected integer or vector, found '${formatType(this.typeOfValue(v, e.line))}'.`, e.line);
        if (dest.k === 'comptime') return { k: 'int', v: v.v };
        if (this.bitSize(dest, e.line) === 0) return { k: 'int', v: 0n, type: dest };
        if (v.type) {
          if (this.isSignedInt(v.type) !== this.isSignedInt(dest)) {
            throw new ZigLayoutError(`Expected ${this.isSignedInt(dest) ? 'signed' : 'unsigned'} integer type, found '${formatType(v.type)}'.`, e.line);
          }
          if (this.bitSize(dest, e.line) >= this.bitSize(v.type, e.line)) return this.coerce(v, dest, e.line);
        }
        return this.truncate(v.v, dest, e.line);
      }
      case '@enumFromInt':
      case '@fromBackingInt': {
        // An enum value from its integer (packed containers are not modelled as values).
        want(1);
        const dest = this.castDest(e.name, rt, e.line);
        if (dest.k !== 'container' || dest.c.decl.kind !== 'enum') {
          throw new ZigLayoutError(`${e.name} gives an enum${e.name === '@fromBackingInt' ? ' (or a packed container, not modelled here)' : ''}, not '${formatType(dest)}'.`, e.line);
        }
        const info = this.enumInfo(dest.c);
        let v = intArg(0);
        if (e.name === '@fromBackingInt') v = this.coerce(v, info.tag, e.line) as Extract<Value, { k: 'int' }>;
        const index = info.values.indexOf(v.v);
        if (index < 0) {
          if (dest.c.decl.nonexhaustive) throw new ZigLayoutError(`An unnamed value of the non-exhaustive enum '${dest.c.name}' is not modelled here.`, e.line);
          throw new ZigLayoutError(`Enum '${dest.c.name}' has no tag with value '${v.v}'.`, e.line);
        }
        return { k: 'enumValue', type: dest.c, name: dest.c.decl.fields.filter((f) => f.name !== '_')[index]!.name! };
      }
      case '@backingInt': {
        want(1);
        const v = this.eval(args[0]!, scope);
        if (v.k !== 'enumValue') throw new ZigLayoutError(`Expected enum, tagged union, packed union or packed struct, found '${formatType(this.typeOfValue(v, e.line))}'.`, e.line);
        return this.enumInt(v);
      }
      case '@bitCast': {
        // Between integers (and from an enum) of one bit size: the same bits.
        want(1);
        const dest = this.castDest(e.name, rt, e.line);
        let v = this.eval(args[0]!, scope);
        if (v.k === 'enumValue') v = this.enumInt(v);
        if (v.k === 'int' && !v.type) throw new ZigLayoutError("Cannot @bitCast from 'comptime_int'.", e.line);
        if (v.k !== 'int' || !this.isIntType(dest)) throw new ZigLayoutError(`@bitCast to '${formatType(dest)}' from ${describeValue(v)} is not modelled here.`, e.line);
        const from = this.bitSize(v.type!, e.line);
        const to = this.bitSize(dest, e.line);
        if (from !== to) throw new ZigLayoutError(`@bitCast size mismatch: destination type '${formatType(dest)}' has ${to} bits but source type '${formatType(v.type!)}' has ${from} bits.`, e.line);
        return this.truncate(v.v, dest, e.line);
      }
      case '@clz':
      case '@ctz':
      case '@popCount': {
        want(1);
        const v = this.eval(args[0]!, scope);
        if (v.k !== 'int' || !v.type) throw new ZigLayoutError(`${e.name} needs an integer of a fixed width, not comptime_int.`, e.line);
        const bits = this.bitSize(v.type, e.line);
        const binary = BigInt.asUintN(bits, v.v).toString(2).padStart(bits, '0');
        const n =
          e.name === '@clz' ? binary.length - binary.replace(/^0+/, '').length : e.name === '@ctz' ? binary.length - binary.replace(/0+$/, '').length : [...binary].filter((c) => c === '1').length;
        // The result is the smallest unsigned integer that holds the width (std.math.Log2IntCeil).
        return { k: 'int', v: BigInt(n), type: { k: 'int', signed: false, bits: smallestUnsignedBits(bits) } };
      }
      case '@intFromEnum': {
        want(1);
        const v = this.eval(args[0]!, scope);
        if (v.k !== 'enumValue') throw new ZigLayoutError(`@intFromEnum takes an enum value, not ${describeValue(v)}.`, e.line);
        return this.enumInt(v);
      }
      case '@intFromBool':
        want(1);
        return { k: 'int', v: this.evalBool(args[0]!, scope) ? 1n : 0n, type: { k: 'int', signed: false, bits: 1 } };
      case '@disableInstrumentation':
        // Code generation only.
        want(0);
        return { k: 'void' };
      case '@min':
      case '@max': {
        // Sema.analyzeMinMax: of comptime-known integers, the least or greatest value, as
        // comptime_int when every operand is one, else as the smallest integer type that holds it
        // (Type.intFittingRange of the result's bounds), whatever the operands' types.
        if (args.length < 2) throw new ZigLayoutError(`${e.name} expects at least 2 arguments, found ${args.length}.`, e.line);
        const vs = args.map((a) => this.eval(a, scope));
        for (const v of vs) {
          if (v.k === 'float') throw new ZigLayoutError(`${e.name} of floats is not modelled here.`, e.line);
          if (v.k !== 'int') throw new ZigLayoutError(`Expected number, found '${formatType(this.typeOfValue(v, e.line))}'.`, e.line);
        }
        const ints = vs as Extract<Value, { k: 'int' }>[];
        const pick = ints.map((v) => v.v).reduce((m, v) => (e.name === '@min' ? (v < m ? v : m) : v > m ? v : m));
        return ints.every((v) => !v.type) ? { k: 'int', v: pick } : { k: 'int', v: pick, type: this.intFitting(pick) };
      }
      case '@divExact':
      case '@divTrunc':
      case '@divFloor':
      case '@divCeil':
      case '@mod':
      case '@rem': {
        // The operands' peer type, which each must fit; the result must fit it too.
        want(2);
        const l = intArg(0);
        const r = intArg(1);
        const peer = this.peerIntType([l, r], e.line);
        const a = l.v;
        const b = r.v;
        if (b === 0n) throw new ZigLayoutError('Division by zero here causes illegal behavior.', e.line);
        const trunc = a / b;
        const inexact = a % b !== 0n;
        let v: bigint;
        switch (e.name) {
          case '@divExact':
            if (inexact) throw new ZigLayoutError(`Exact division produced remainder: @divExact(${a}, ${b}).`, e.line);
            v = trunc;
            break;
          case '@divTrunc':
            v = trunc;
            break;
          case '@divFloor':
            v = inexact && a < 0n !== b < 0n ? trunc - 1n : trunc;
            break;
          case '@divCeil':
            v = inexact && a < 0n === b < 0n ? trunc + 1n : trunc;
            break;
          case '@rem':
            v = a % b;
            break;
          default: {
            const rem = a % b;
            v = rem !== 0n && rem < 0n !== b < 0n ? rem + b : rem;
          }
        }
        return this.intResult(v, peer, e.name, e.line);
      }
      case '@compileError': {
        want(1);
        const msg = this.eval(args[0]!, scope);
        throw new ZigLayoutError(msg.k === 'string' ? msg.v : '@compileError', e.line);
      }
      default:
        throw new ZigLayoutError(`${e.name} is not supported in a type expression.`, e.line);
    }
  }

  /** A value of one of std's enums (std.builtin.OptimizeMode, std.Target.Cpu.Arch, ...). */
  private stdEnum(path: readonly string[], name: string): Value {
    let v = this.stdValue();
    for (const segment of path) v = this.fieldAccess(v, segment, 0, this.rootScope);
    if (v.k !== 'type' || v.t.k !== 'container' || v.t.c.decl.kind !== 'enum') throw new Error(`std prelude: ${path.join('.')} is not an enum`);
    return this.coerce({ k: 'enumLit', name }, v.t, 0);
  }

  /**
   * @import("builtin"): the build mode and the target, as the values of std's enums they are. The
   * mode is a std.lang.Optimize (`optimize`, and `mode`, its deprecated name), whose fields are the
   * -O names debug, safe, fast and small.
   */
  private builtinModule(): Value {
    const rec = (entries: [string, Value][]): Value => ({ k: 'record', fields: new Map(entries) });
    const t = this.target;
    const cpu = rec([['arch', this.stdEnum(['Target', 'Cpu', 'Arch'], t.arch)]]);
    const os = rec([['tag', this.stdEnum(['Target', 'Os', 'Tag'], t.os)]]);
    const abi = this.stdEnum(['Target', 'Abi'], t.abi);
    const optimize = this.stdEnum(['lang', 'Optimize'], OPTIMIZE_FIELD[this.options.mode]);
    return rec([
      ['optimize', optimize],
      ['mode', optimize],
      ['target', rec([['cpu', cpu], ['os', os], ['abi', abi]])],
      ['cpu', cpu],
      ['os', os],
      ['abi', abi],
      ['is_test', { k: 'bool', v: false }],
    ]);
  }

  /** A type std declares (std.lang.Type.Int, std.Target, ...), by its path from std. */
  private stdType(path: readonly string[]): ZType {
    let v = this.stdValue();
    for (const segment of path) v = this.fieldAccess(v, segment, 0, this.rootScope);
    if (v.k !== 'type') throw new Error(`std prelude: ${path.join('.')} is not a type`);
    return v.t;
  }

  /**
   * @typeInfo: a std.lang.Type (std.builtin.Type), the tagged union of what a type is, with
   * 0.17's fields. What the engine does not give (declaration names, the names of an error set,
   * the elements of the field slices) is an error to read.
   */
  private typeInfo(t: ZType): Value {
    const T = (...path: string[]) => this.stdType(['lang', 'Type', ...path]);
    const rec = (type: ZType, entries: [string, Value][]): Value => ({ k: 'record', fields: new Map(entries), type });
    const info = (tag: string, payload: Value = { k: 'void' }): Value => ({ k: 'union', tag, payload, type: T() });
    const type = (x: ZType): Value => ({ k: 'type', t: x });
    const typeT: ZType = { k: 'comptime', name: 'type' };
    const optType = (x: ZType | null): Value => ({ k: 'optional', v: x ? type(x) : null, type: { k: 'opt', child: typeT } });
    const bool = (v: boolean): Value => ({ k: 'bool', v });
    const u16 = (n: number): Value => ({ k: 'int', v: BigInt(n), type: { k: 'int', signed: false, bits: 16 } });
    const comptimeInt = (n: number): Value => ({ k: 'int', v: BigInt(n) });
    const layout = (l: string) => this.stdEnum(['lang', 'Type', 'ContainerLayout'], l);
    // A slice: its len (a usize); its elements are not given.
    const slice = (n: number): Value => ({ k: 'record', fields: new Map([['len', { k: 'int', v: BigInt(n), type: { k: 'usize' } }]]) });
    const unmodelled = (what: string): Value => ({ k: 'unmodelled', what });
    const int = (signed: boolean, bits: number) =>
      info('int', rec(T('Int'), [['signedness', this.stdEnum(['lang', 'Signedness'], signed ? 'signed' : 'unsigned')], ['bits', u16(bits)]]));
    switch (t.k) {
      case 'int':
        return int(t.signed, t.bits);
      case 'usize':
      case 'isize':
        return int(t.k === 'isize', ptrBits(this.target));
      case 'c':
        return int(t.signed, cTypeBitSize(this.target, t.c));
      case 'float':
        return info('float', rec(T('Float'), [['bits', u16(t.bits)]]));
      case 'c_longdouble':
        return info('float', rec(T('Float'), [['bits', u16(cTypeBitSize(this.target, 'longdouble'))]]));
      case 'bool':
      case 'void':
      case 'noreturn':
        return info(t.k);
      case 'anyopaque':
        return info('opaque', rec(T('Opaque'), [['decl_names', unmodelled("anyopaque's declarations")]]));
      case 'comptime':
        return info(
          t.name === '@EnumLiteral()' ? 'enum_literal' : t.name === '@TypeOf(null)' ? 'null' : t.name === '@TypeOf(undefined)' ? 'undefined' : t.name,
        );
      case 'ptr': {
        const usize: ZType = { k: 'usize' };
        const attrs = rec(T('Pointer', 'Attributes'), [
          ['const', bool(t.isConst)],
          ['volatile', bool(t.isVolatile)],
          ['allowzero', bool(t.allowzero)],
          ['addrspace', unmodelled("a pointer type's address space")],
          ['align', { k: 'optional', v: t.align !== undefined ? { k: 'int', v: BigInt(t.align), type: usize } : null, type: { k: 'opt', child: usize } }],
        ]);
        return info(
          'pointer',
          rec(T('Pointer'), [
            ['size', this.stdEnum(['lang', 'Type', 'Pointer', 'Size'], t.size)],
            ['attrs', attrs],
            ['child', type(t.child)],
            ['sentinel_ptr', unmodelled("a pointer type's sentinel")],
          ]),
        );
      }
      case 'array':
        return info('array', rec(T('Array'), [['len', comptimeInt(t.len)], ['child', type(t.child)], ['sentinel_ptr', unmodelled("an array type's sentinel")]]));
      case 'vector':
        return info('vector', rec(T('Vector'), [['len', comptimeInt(t.len)], ['child', type(t.child)]]));
      case 'opt':
        return info('optional', rec(T('Optional'), [['child', type(t.child)]]));
      case 'errunion':
        return info('error_union', rec(T('ErrorUnion'), [['error_set', type(t.set)], ['payload', type(t.payload)]]));
      case 'errset':
        return info('error_set', rec(T('ErrorSet'), [['error_names', unmodelled("an error set's names")]]));
      case 'fn':
        return info('fn', unmodelled("a function type's parameters"));
      case 'container': {
        const c = t.c;
        const d = c.decl;
        const decls = unmodelled(`the declaration names of '${c.name}'`);
        if (d.kind === 'enum') {
          const e = this.enumInfo(c);
          const n = d.fields.filter((f) => f.name !== '_').length;
          const mode = this.stdEnum(['lang', 'Type', 'Enum', 'Mode'], d.nonexhaustive ? 'nonexhaustive' : 'exhaustive');
          return info('enum', rec(T('Enum'), [['tag_type', type(e.tag)], ['mode', mode], ['field_names', slice(n)], ['field_values', slice(n)], ['decl_names', decls]]));
        }
        if (d.kind === 'opaque') return info('opaque', rec(T('Opaque'), [['decl_names', decls]]));
        const n = d.fields.length;
        const backing = optType(d.layout === 'packed' ? this.packedInfo(c).backing : null);
        if (d.kind === 'union') {
          const tag = optType(d.layout === 'auto' && (d.unionEnum || d.arg) ? this.unionTagType(c) : null);
          return info(
            'union',
            rec(T('Union'), [['layout', layout(d.layout)], ['tag_type', tag], ['backing_integer', backing], ['field_names', slice(n)], ['field_types', slice(n)], ['field_attrs', slice(n)], ['decl_names', decls]]),
          );
        }
        return info(
          'struct',
          rec(T('Struct'), [['is_tuple', bool(c.tuple)], ['layout', layout(d.layout)], ['backing_integer', backing], ['field_names', slice(n)], ['field_types', slice(n)], ['field_attrs', slice(n)], ['decl_names', decls]]),
        );
      }
    }
  }

  // ---------------------------------------------------------------- fields

  fieldsOf(c: Container): ResolvedField[] {
    if (c.fields) return c.fields;
    if (c.decl.kind === 'enum' || c.decl.kind === 'opaque') return (c.fields = []);
    const fields: ResolvedField[] = [];
    c.decl.fields.forEach((f, i) => {
      const name = f.name ?? String(i);
      if (fields.some((x) => x.name === name)) throw new ZigLayoutError(`Duplicate field '${name}'.`, f.line);
      let type: ZType;
      if (f.type) {
        type = this.evalType(f.type, c.scope, f.type.k === 'container' ? `${c.name}.${name}` : undefined);
      } else {
        type = { k: 'void' };
      }
      if (f.comptime && !f.value) throw new ZigLayoutError(`comptime field '${name}' needs a value.`, f.line);
      if (f.comptime && c.decl.layout !== 'auto') throw new ZigLayoutError(`${c.decl.layout} structs cannot have comptime fields.`, f.line);
      fields.push({ name, type, align: f.align ? this.evalAlign(f.align, c.scope) : undefined, comptime: f.comptime, line: f.line, decl: f });
    });
    c.fields = fields;
    return fields;
  }

  // ---------------------------------------------------------------- layout

  private ptrSize(t: Extract<ZType, { k: 'ptr' }>): number {
    return t.size === 'slice' ? 2 * this.ptrBytes : this.ptrBytes;
  }

  /** Bits of an error code: Zcu.errorSetBits, log2 of --error-limit plus one (16 by default). */
  private errorBits(): number {
    const limit = this.errorLimit;
    return limit === 0 ? 0 : Math.floor(Math.log2(limit)) + 1;
  }

  get errorLimit(): number {
    return this.options.errorLimit ?? DEFAULT_ERROR_LIMIT;
  }

  /** Type.classify */
  classify(t: ZType, line?: number): Class {
    let extra: 'none' | 'one' | 'many' = 'none';
    let cur = t;
    let base: Class;
    for (;;) {
      if (cur.k === 'int') {
        base = cur.bits === 0 ? 'opv' : 'runtime';
        break;
      }
      if (cur.k === 'array') {
        if (cur.len === 0 && cur.sentinel === undefined) {
          base = 'opv';
          break;
        }
        cur = cur.child;
        continue;
      }
      if (cur.k === 'vector') {
        if (cur.len === 0) {
          base = 'opv';
          break;
        }
        cur = cur.child;
        continue;
      }
      if (cur.k === 'opt') {
        extra = extra === 'none' ? 'one' : 'many';
        cur = cur.child;
        continue;
      }
      if (cur.k === 'errunion') {
        extra = 'many';
        cur = cur.payload;
        continue;
      }
      if (cur.k === 'container') {
        const d = cur.c.decl;
        if (d.kind === 'enum') {
          cur = this.enumInfo(cur.c).tag;
          continue;
        }
        if (d.kind === 'opaque') {
          base = 'npv';
          break;
        }
        if (d.layout === 'packed') {
          base = this.packedBits(cur.c, line) === 0 ? 'opv' : 'runtime';
          break;
        }
        base = this.containerLayout(cur.c, line).cls;
        break;
      }
      switch (cur.k) {
        case 'anyopaque':
        case 'noreturn':
          base = 'npv';
          break;
        case 'void':
          base = 'opv';
          break;
        case 'comptime':
        case 'fn':
          base = 'comptime';
          break;
        default:
          base = 'runtime';
      }
      break;
    }
    if (base === 'runtime' || base === 'partial' || base === 'comptime') return base;
    if (base === 'npv') return extra === 'none' ? 'npv' : extra === 'one' ? 'opv' : 'runtime';
    return extra === 'none' ? 'opv' : 'runtime';
  }

  private hasRuntimeBits(t: ZType, line?: number): boolean {
    const c = this.classify(t, line);
    return c === 'runtime' || c === 'partial';
  }

  /**
   * Type.bitSize, of the types with a bit representation (Type.hasBitRepresentation, which
   * @bitSizeOf requires, and which also lets in error sets and every enum): integers, floats, bool,
   * void, pointers and pointer-like optionals, packed containers, enums, and arrays and vectors of
   * these, `len` times their element's bits. Other types (plain structs and unions, slices, error
   * unions, other optionals) have none.
   */
  bitSize(t: ZType, line?: number): number {
    const none = () => new ZigLayoutError(`No bit size available for type '${formatType(t)}'.`, line);
    switch (t.k) {
      case 'int':
        return t.bits;
      case 'usize':
      case 'isize':
        return ptrBits(this.target);
      case 'c':
        return cTypeBitSize(this.target, t.c);
      case 'c_longdouble':
        return cTypeBitSize(this.target, 'longdouble');
      case 'float':
        return t.bits;
      case 'bool':
        return 1;
      case 'void':
        return 0;
      case 'ptr':
        if (t.size === 'slice') throw none();
        return ptrBits(this.target);
      case 'opt':
        if (!this.isPtrAtRuntime(t)) throw none();
        return ptrBits(this.target);
      case 'errset':
        return this.errorBits();
      case 'vector':
        return t.len * this.bitSize(t.child, line);
      case 'array':
        return (t.len + (t.sentinel !== undefined ? 1 : 0)) * this.bitSize(t.child, line);
      case 'container': {
        const d = t.c.decl;
        if (d.kind === 'enum') return this.bitSize(this.enumInfo(t.c).tag, line);
        if (d.layout === 'packed') return this.packedBits(t.c, line);
        throw none();
      }
      default:
        throw none();
    }
  }

  /** Type.isPtrAtRuntime: a pointer other than a slice, or an optional one that is only a pointer. */
  private isPtrAtRuntime(t: ZType): boolean {
    if (t.k === 'ptr') return t.size !== 'slice';
    if (t.k === 'opt' && t.child.k === 'ptr') return (t.child.size === 'one' || t.child.size === 'many') && !t.child.allowzero;
    return false;
  }

  layoutOf(t: ZType, line?: number): ZLayout {
    return this.nesting.in(() => this.layoutOfHere(t, line), line);
  }

  private layoutOfHere(t: ZType, line?: number): ZLayout {
    const target = this.target;
    switch (t.k) {
      case 'int':
        return { size: intByteSize(target, t.bits), align: t.bits === 0 ? 1 : intAlignment(target, t.bits), cls: t.bits === 0 ? 'opv' : 'runtime' };
      case 'usize':
      case 'isize':
        return { size: this.ptrBytes, align: intAlignment(target, ptrBits(target)), cls: 'runtime' };
      case 'c':
        return { size: cTypeByteSize(target, t.c), align: cTypeAlignment(target, t.c), cls: 'runtime' };
      case 'c_longdouble':
        return { size: cTypeByteSize(target, 'longdouble'), align: cTypeAlignment(target, 'longdouble'), cls: 'runtime' };
      case 'float':
        return { ...floatLayout(target, t.bits), cls: 'runtime' };
      case 'bool':
        return { size: 1, align: 1, cls: 'runtime' };
      case 'void':
        return { size: 0, align: 1, cls: 'opv' };
      case 'noreturn':
        return { size: 0, align: 1, cls: 'npv' };
      case 'anyopaque':
        throw new ZigLayoutError('anyopaque has no size: use a pointer to it.', line);
      case 'comptime':
        return { size: 0, align: 1, cls: 'comptime' };
      case 'fn':
        return { size: 0, align: minFunctionAlignment(target), cls: 'comptime' };
      case 'ptr':
        return { size: this.ptrSize(t), align: this.ptrBytes, cls: 'runtime' };
      case 'array': {
        const child = this.layoutOf(t.child, line);
        const n = t.len + (t.sentinel !== undefined ? 1 : 0);
        return { size: n * child.size, align: child.align, cls: this.classify(t, line) };
      }
      case 'vector':
        return this.vectorLayout(t, line);
      case 'opt': {
        const child = this.layoutOf(t.child, line);
        const cls = this.classify(t, line);
        const childCls = this.classify(t.child, line);
        if (childCls === 'npv') return { size: 0, align: child.align, cls };
        if (this.optionalReprIsPayload(t)) return { size: child.size, align: child.align, cls };
        return { size: child.size + child.align, align: child.align, cls };
      }
      case 'errset': {
        const bits = this.errorBits();
        return { size: intByteSize(target, bits), align: intAlignment(target, bits), cls: 'runtime' };
      }
      case 'errunion': {
        const payload = this.layoutOf(t.payload, line);
        const err = this.layoutOf(t.set, line);
        const align = Math.max(err.align, payload.align);
        if (this.classify(t.payload, line) === 'comptime') return { size: 0, align, cls: 'comptime' };
        return { size: alignForward(err.size + payload.size, align), align, cls: this.classify(t, line) };
      }
      case 'container':
        return this.containerLayout(t.c, line);
    }
  }

  /** Type.optionalReprIsPayload: null is a zero pointer, or a zero error code. */
  private optionalReprIsPayload(t: Extract<ZType, { k: 'opt' }>): boolean {
    const c = t.child;
    if (c.k === 'errset') return true;
    return c.k === 'ptr' && c.size !== 'c' && !c.allowzero;
  }

  /**
   * Type.abiAlignment and abiSize of a vector: by the LLVM backend's rule, or by the self-hosted
   * x86-64 backend's, which aligns to 16 bytes, or 32 and 64 with AVX and AVX-512F on the CPU.
   */
  private vectorLayout(t: Extract<ZType, { k: 'vector' }>, line?: number): ZLayout {
    if (t.len === 0) return { size: 0, align: 1, cls: 'opv' };
    if (zigBackend(this.target, this.options.mode) === 'x86_64') {
      const cpu = getZigCpu(this.target, this.options.cpu);
      if (t.child.k === 'bool') {
        const align = t.len > 256 && cpu.avx512f ? 64 : t.len > 128 && cpu.avx ? 32 : t.len > 64 ? 16 : ceilPow2(Math.ceil(t.len / 8));
        return { size: alignForward(Math.ceil(t.len / 8), align), align, cls: 'runtime' };
      }
      const elem = this.layoutOf(t.child, line).size;
      if (elem === 0) return { size: 0, align: 1, cls: 'opv' };
      const bytes = t.len * elem;
      const align = bytes > 32 && cpu.avx512f ? 64 : bytes > 16 && cpu.avx ? 32 : 16;
      return { size: alignForward(bytes, align), align, cls: 'runtime' };
    }
    // Floats the target emulates in software are laid out as an array of them.
    const floatBits = t.child.k === 'float' ? t.child.bits : t.child.k === 'c_longdouble' ? cTypeBitSize(this.target, 'longdouble') : undefined;
    if (floatBits !== undefined && compilerRtFloatAbi(this.target, floatBits) === 'soft') {
      const elem = this.layoutOf(t.child, line);
      return { size: alignForward(t.len * elem.size, elem.align), align: elem.align, cls: 'runtime' };
    }
    const elemBits = this.bitSize(t.child, line);
    if (elemBits === 0) return { size: 0, align: 1, cls: 'opv' };
    const bytes = Math.ceil((elemBits * t.len) / 8);
    // ARM and AArch64 align a vector to at most the stack's alignment.
    const arch = this.target.arch;
    const align = ceilPow2(arch === 'arm' || arch === 'thumb' || arch === 'aarch64' ? Math.min(bytes, stackAlignment(this.target)) : bytes);
    return { size: alignForward(bytes, align), align, cls: 'runtime' };
  }


  enumInfo(c: Container): { tag: ZType; inferred: boolean; values: bigint[] } {
    if (c.enumInfo) return c.enumInfo;
    const d = c.decl;
    const fields = d.fields.filter((f) => f.name !== '_');
    let tag: ZType;
    let inferred = false;
    if (d.arg) {
      tag = this.evalType(d.arg, c.scope);
      if (tag.k !== 'int' && tag.k !== 'usize' && tag.k !== 'isize' && tag.k !== 'c') {
        throw new ZigLayoutError(`Expected an integer tag type, found '${formatType(tag)}'.`, d.line);
      }
    } else {
      if (d.nonexhaustive) throw new ZigLayoutError('A non-exhaustive enum needs an integer tag type: enum(u8) { ..., _ }.', d.line);
      tag = { k: 'int', signed: false, bits: smallestUnsignedBits(Math.max(0, fields.length - 1)) };
      inferred = true;
    }
    const { min, max } = this.intRange(tag);
    const values: bigint[] = [];
    const seen = new Map<bigint, string>();
    for (const [i, f] of fields.entries()) {
      let v: bigint;
      if (f.value) {
        if (inferred) throw new ZigLayoutError(`Field '${f.name}' has a value: give the enum an integer tag type, e.g. enum(u8).`, f.line);
        v = this.evalInt(f.value, c.scope, tag);
      } else {
        v = i === 0 ? 0n : values[i - 1]! + 1n;
      }
      if (v < min || v > max) throw new ZigLayoutError(`Enum tag value ${v} for '${f.name}' does not fit in '${formatType(tag)}'.`, f.line);
      const prev = seen.get(v);
      if (prev !== undefined) throw new ZigLayoutError(`Enum tag value ${v} for '${f.name}' is already taken by '${prev}'.`, f.line);
      seen.set(v, f.name!);
      values.push(v);
    }
    if (d.nonexhaustive && fields.length >= 1 && Math.log2(fields.length) === this.bitSize(tag)) {
      throw new ZigLayoutError('A non-exhaustive enum must leave some values of its tag type unused.', d.line);
    }
    c.enumInfo = { tag, inferred, values };
    return c.enumInfo;
  }

  private intRange(t: ZType): { min: bigint; max: bigint } {
    const bits = BigInt(this.bitSize(t));
    const signed = t.k === 'int' ? t.signed : t.k === 'isize' ? true : t.k === 'c' ? t.signed : false;
    if (bits === 0n) return { min: 0n, max: 0n };
    return signed ? { min: -(1n << (bits - 1n)), max: (1n << (bits - 1n)) - 1n } : { min: 0n, max: (1n << bits) - 1n };
  }

  /** Type.unpackable: what a packed struct or union may hold (no pointers, since 0.15). */
  private packableError(t: ZType): string | undefined {
    switch (t.k) {
      case 'int':
      case 'usize':
      case 'isize':
      case 'c':
      case 'float':
      case 'c_longdouble':
      case 'bool':
      case 'void':
        return undefined;
      case 'ptr':
        return t.size === 'slice' ? 'slices cannot be packed' : 'pointers cannot be packed (since Zig 0.15): store a usize and convert';
      case 'opt':
        return t.child.k === 'ptr' && t.child.size !== 'slice' && t.child.size !== 'c' && !t.child.allowzero ? 'pointers cannot be packed (since Zig 0.15)' : 'optionals cannot be packed';
      case 'container': {
        const d = t.c.decl;
        if (d.kind === 'enum') return this.enumInfo(t.c).inferred ? `enum '${t.c.name}' has an inferred tag type: give it one, e.g. enum(u2)` : undefined;
        if (d.layout === 'packed') return undefined;
        return `${d.kind} '${t.c.name}' is not packed`;
      }
      default:
        return `'${formatType(t)}' cannot be packed`;
    }
  }

  /** Bits of a packed struct's or union's backing integer. */
  packedBits(c: Container, line?: number): number {
    return this.packedInfo(c, line).backingBits;
  }

  private readonly packedResolving = new Set<Container>();
  private readonly packedCache = new WeakMap<Container, { backingBits: number; backing: ZType; offsets: number[]; explicit: boolean }>();

  private packedInfo(c: Container, line?: number): { backingBits: number; backing: ZType; offsets: number[]; explicit: boolean } {
    const cached = this.packedCache.get(c);
    if (cached) return cached;
    if (this.packedResolving.has(c)) throw new ZigLayoutError(`'${c.name}' depends on itself.`, line ?? c.decl.line);
    this.packedResolving.add(c);
    try {
      const fields = this.fieldsOf(c);
      const d = c.decl;
      if (d.kind === 'union' && fields.length === 0) throw new ZigLayoutError('A packed union has no fields.', d.line);
      const bits: number[] = [];
      for (const f of fields) {
        const why = this.packableError(f.type);
        if (why) throw new ZigLayoutError(`packed ${d.kind}s cannot contain fields of type '${formatType(f.type)}': ${why}.`, f.line);
        if (f.align !== undefined) throw new ZigLayoutError(`Fields of a packed ${d.kind} cannot have an alignment.`, f.line);
        bits.push(this.bitSize(f.type, f.line));
      }
      const offsets: number[] = [];
      let total: number;
      if (d.kind === 'struct') {
        let at = 0;
        for (const b of bits) {
          offsets.push(at);
          at += b;
        }
        total = at;
      } else {
        total = bits[0]!;
        fields.forEach((f, i) => {
          if (bits[i] !== total && !d.arg) {
            throw new ZigLayoutError(`All fields of a packed union must have the same bit size: '${fields[0]!.name}' has ${total}, '${f.name}' has ${bits[i]}.`, f.line);
          }
          offsets.push(0);
        });
      }
      let backing: ZType;
      if (d.arg) {
        const explicit = this.evalType(d.arg, c.scope);
        if (explicit.k !== 'int') throw new ZigLayoutError(`Expected a backing integer type, found '${formatType(explicit)}'.`, d.line);
        if (d.kind === 'struct' && explicit.bits !== total) {
          throw new ZigLayoutError(`The backing integer '${formatType(explicit)}' has ${explicit.bits} bits; the fields have ${total}.`, d.line);
        }
        if (d.kind === 'union') {
          fields.forEach((f, i) => {
            if (bits[i] !== explicit.bits) throw new ZigLayoutError(`Field '${f.name}' has ${bits[i]} bits; the backing integer '${formatType(explicit)}' has ${explicit.bits}.`, f.line);
          });
        }
        backing = explicit;
        total = explicit.bits;
      } else {
        if (total > 65535) throw new ZigLayoutError(`A packed ${d.kind} of ${total} bits is wider than 65535.`, d.line);
        backing = { k: 'int', signed: false, bits: total };
      }
      const info = { backingBits: total, backing, offsets, explicit: d.arg !== undefined };
      this.packedCache.set(c, info);
      return info;
    } finally {
      this.packedResolving.delete(c);
    }
  }


  /** Type.validateExtern */
  private externError(t: ZType, position: 'struct_field' | 'union_field' | 'element'): string | undefined {
    switch (t.k) {
      case 'comptime':
      case 'errset':
      case 'errunion':
        return 'only C types can be in an extern container';
      case 'void':
        return undefined;
      case 'noreturn':
        return 'noreturn is not a field type';
      case 'bool':
      case 'float':
      case 'c_longdouble':
      case 'c':
      case 'usize':
      case 'isize':
        return undefined;
      case 'anyopaque':
        return undefined;
      case 'ptr':
        if (t.size === 'slice') return 'slices have no C equivalent: use a pointer and a length';
        if (t.child.k === 'fn') {
          if (!t.isConst) return 'a function pointer must be *const fn';
          if (!t.child.callconv || t.child.callconv === 'auto' || t.child.callconv === 'async' || t.child.callconv === 'inline') {
            return 'the function needs a C calling convention: add callconv(.c)';
          }
        }
        return undefined;
      case 'int':
        return [0, 8, 16, 32, 64, 128].includes(t.bits) ? undefined : `u${t.bits}/i${t.bits} has no C equivalent: use a power-of-two width from 8 to 128`;
      case 'fn':
        return 'a function body is not a field type: use *const fn ... callconv(.c)';
      case 'array':
        return this.externError(t.child, 'element');
      case 'vector':
        return this.externError(t.child, 'element');
      case 'opt':
        if (t.child.k === 'ptr' && (t.child.size === 'one' || t.child.size === 'many') && !t.child.allowzero) return undefined;
        return 'only optional pointers have a C equivalent';
      case 'container': {
        const d = t.c.decl;
        if (t.c.tuple) return 'tuples have no C layout';
        if (d.kind === 'enum') {
          const info = this.enumInfo(t.c);
          if (info.inferred) return `enum '${t.c.name}' has an inferred tag type: give it one, e.g. enum(c_int)`;
          return this.externError(info.tag, position);
        }
        if (d.kind === 'opaque') return undefined;
        if (d.layout === 'extern') return undefined;
        if (d.layout === 'packed') {
          const info = this.packedInfo(t.c);
          if (!info.explicit) return `packed ${d.kind} '${t.c.name}' needs an explicit backing integer, e.g. packed ${d.kind}(u32)`;
          return this.externError(info.backing, position);
        }
        return `${d.kind} '${t.c.name}' has no guaranteed layout: make it extern`;
      }
    }
  }

  private safetyTags(): boolean {
    return runtimeSafety(this.options.mode);
  }

  containerLayout(c: Container, line?: number): ZLayout {
    if (c.layout) return c.layout;
    const d = c.decl;
    if (d.kind === 'opaque') throw new ZigLayoutError(`Opaque type '${c.name}' has no size: use a pointer to it.`, line ?? d.line);
    if (d.kind === 'enum') {
      const info = this.enumInfo(c);
      const l = this.layoutOf(info.tag, line);
      c.layout = { ...l, record: this.enumRecord(c, info, l) };
      this.reached.add(c);
      return c.layout;
    }
    if (c.resolving) throw new ZigLayoutError(`'${c.name}' depends on itself: a field holds it directly. Use a pointer.`, line ?? d.line);
    c.resolving = true;
    try {
      let l: ZLayout;
      if (d.layout === 'packed') l = this.packedLayout(c, line);
      else if (d.kind === 'union') l = this.unionLayout(c);
      else if (c.tuple) l = this.tupleLayout(c);
      else l = this.structLayout(c);
      c.layout = l;
      this.reached.add(c);
      return l;
    } finally {
      c.resolving = false;
    }
  }

  private checkFieldType(c: Container, f: ResolvedField): void {
    const t = f.type;
    if (t.k === 'anyopaque' || (t.k === 'container' && t.c.decl.kind === 'opaque')) {
      throw new ZigLayoutError(`Cannot embed opaque type '${formatType(t)}' in a ${c.decl.kind}: opaque types have unknown size. Use a pointer.`, f.line);
    }
    if (c.decl.layout === 'extern') {
      const why = this.externError(t, c.decl.kind === 'union' ? 'union_field' : 'struct_field');
      if (why) throw new ZigLayoutError(`extern ${c.decl.kind}s cannot contain fields of type '${formatType(t)}': ${why}.`, f.line);
    }
  }

  /** Sema.type_resolution.resolveStructLayout for auto and extern structs. */
  private structLayout(c: Container): ZLayout {
    const fields = this.fieldsOf(c);
    const layout = c.decl.layout as 'auto' | 'extern';
    for (const f of fields) {
      this.checkFieldType(c, f);
      this.layoutOf(f.type, f.line);
    }
    // A field is aligned as written, else as its type: extern structs too.
    const aligns = fields.map((f) => f.align ?? this.layoutOf(f.type, f.line).align);
    let structAlign = 1;
    let npv = false;
    let runtime = false;
    let comptime = false;
    const OMITTED = -1;
    const order: number[] = [];
    fields.forEach((f, i) => {
      if (f.comptime) {
        order.push(OMITTED);
        return;
      }
      structAlign = Math.max(structAlign, aligns[i]!);
      order.push(i);
      switch (this.classify(f.type, f.line)) {
        case 'npv':
          npv = true;
          break;
        case 'runtime':
          runtime = true;
          break;
        case 'comptime':
          comptime = true;
          break;
        case 'partial':
          runtime = true;
          comptime = true;
          break;
        default:
          break;
      }
    });
    const cls: Class = npv ? 'npv' : comptime ? (runtime ? 'partial' : 'comptime') : runtime ? 'runtime' : 'opv';
    if (layout === 'auto') {
      // Sort by descending alignment; comptime fields sort last and end the runtime order.
      pdqSort(order, (a, b) => {
        if (a === OMITTED) return false;
        if (b === OMITTED) return true;
        return aligns[a]! > aligns[b]!;
      });
    }
    const runtimeOrder = layout === 'auto' ? order.slice(0, order.includes(OMITTED) ? order.indexOf(OMITTED) : order.length) : order;
    const offsets = new Map<number, number>();
    let cur = 0;
    for (const i of runtimeOrder) {
      const off = alignForward(cur, aligns[i]!);
      offsets.set(i, off);
      cur = off + this.layoutOf(fields[i]!.type).size;
    }
    const size = cls === 'npv' ? 0 : alignForward(cur, structAlign);
    const record = this.structRecord(c, runtimeOrder.map((i) => ({ f: fields[i]!, offset: offsets.get(i)!, align: aligns[i]! })), size, structAlign);
    return { size, align: structAlign, cls, record };
  }

  /**
   * Type.structFieldOffset for tuples: declaration order, comptime and zero-bit fields at 0. The
   * tuple is aligned as its most aligned field (Type.abiAlignment), but its size is rounded up to
   * the alignment of the fields with runtime bits only.
   */
  private tupleLayout(c: Container): ZLayout {
    const fields = this.fieldsOf(c);
    let cur = 0;
    let align = 1;
    let runtimeAlign = 1;
    let npv = false;
    let runtime = false;
    let comptime = false;
    const placed: { f: ResolvedField; offset: number; align: number }[] = [];
    for (const f of fields) {
      this.checkFieldType(c, f);
      if (f.comptime) continue;
      const cls = this.classify(f.type, f.line);
      if (cls === 'npv') npv = true;
      if (cls === 'runtime' || cls === 'partial') runtime = true;
      if (cls === 'comptime' || cls === 'partial') comptime = true;
      const l = this.layoutOf(f.type, f.line);
      align = Math.max(align, l.align);
      if (!this.hasRuntimeBits(f.type, f.line)) {
        placed.push({ f, offset: 0, align: l.align });
        continue;
      }
      runtimeAlign = Math.max(runtimeAlign, l.align);
      cur = alignForward(cur, l.align);
      placed.push({ f, offset: cur, align: l.align });
      cur += l.size;
    }
    const cls: Class = npv ? 'npv' : comptime ? (runtime ? 'partial' : 'comptime') : runtime ? 'runtime' : 'opv';
    const size = cls === 'npv' ? 0 : alignForward(cur, runtimeAlign);
    placed.sort((a, b) => a.offset - b.offset || (this.layoutOf(a.f.type).size === 0 ? -1 : 0));
    return { size, align, cls, record: this.structRecord(c, placed, size, align) };
  }

  /** The tag a union carries at runtime, if any (resolveUnionLayout's has_runtime_tag). */
  unionTag(c: Container): { kind: 'tagged' | 'safety'; type: ZType } | undefined {
    const d = c.decl;
    if (d.kind !== 'union' || d.layout !== 'auto') return undefined;
    const tagged = d.unionEnum === true || d.arg !== undefined;
    if (!tagged && !this.safetyTags()) return undefined;
    const fields = this.fieldsOf(c);
    let possible = 0;
    let comptime = false;
    for (const f of fields) {
      const cls = this.classify(f.type, f.line);
      if (cls === 'npv') continue;
      possible += 1;
      if (cls === 'comptime' || cls === 'partial') comptime = true;
    }
    const tagType = this.unionTagType(c);
    if (possible < 2 || comptime) return undefined;
    if (!this.hasRuntimeBits(tagType)) return undefined;
    return { kind: tagged ? 'tagged' : 'safety', type: tagType };
  }

  private unionTagType(c: Container): ZType {
    const d = c.decl;
    const fields = this.fieldsOf(c);
    if (d.arg) {
      const t = this.evalType(d.arg, c.scope);
      if (t.k !== 'container' || t.c.decl.kind !== 'enum') throw new ZigLayoutError(`Expected an enum tag type, found '${formatType(t)}'.`, d.line);
      const names = t.c.decl.fields.filter((f) => f.name !== '_').map((f) => f.name);
      if (names.length !== fields.length || names.some((n, i) => n !== fields[i]!.name)) {
        throw new ZigLayoutError(`The fields of '${c.name}' must be those of '${t.c.name}', in its order: ${names.join(', ')}.`, d.line);
      }
      this.enumInfo(t.c);
      return t;
    }
    if (d.unionEnumArg) {
      const t = this.evalType(d.unionEnumArg, c.scope);
      if (t.k !== 'int') throw new ZigLayoutError(`Expected an integer tag type, found '${formatType(t)}'.`, d.line);
      const max = this.intRange(t).max;
      if (BigInt(Math.max(0, fields.length - 1)) > max) throw new ZigLayoutError(`'${formatType(t)}' cannot number ${fields.length} fields.`, d.line);
      return t;
    }
    return { k: 'int', signed: false, bits: smallestUnsignedBits(Math.max(0, fields.length - 1)) };
  }

  /** Sema.type_resolution.resolveUnionLayout for auto and extern unions. */
  private unionLayout(c: Container): ZLayout {
    const d = c.decl;
    const fields = this.fieldsOf(c);
    if (fields.length === 0 && d.layout === 'extern') throw new ZigLayoutError('An extern union has no fields.', d.line);
    for (const f of fields) {
      if (f.comptime) throw new ZigLayoutError('Union fields cannot be comptime.', f.line);
      this.checkFieldType(c, f);
    }
    if (d.layout === 'auto' && (d.unionEnum || d.arg)) this.unionTagType(c);
    let payloadAlign = 1;
    let payloadSize = 0;
    let possible = 0;
    let comptime = false;
    for (const f of fields) {
      const l = this.layoutOf(f.type, f.line);
      payloadAlign = Math.max(payloadAlign, f.align ?? l.align);
      payloadSize = Math.max(payloadSize, l.size);
      const cls = this.classify(f.type, f.line);
      if (cls === 'npv') continue;
      possible += 1;
      if (cls === 'comptime' || cls === 'partial') comptime = true;
    }
    const tag = this.unionTag(c);
    let size: number;
    let align: number;
    let tagOffset = 0;
    let payloadOffset = 0;
    let tagLayout: ZLayout | undefined;
    if (!tag) {
      size = alignForward(payloadSize, payloadAlign);
      align = payloadAlign;
    } else {
      tagLayout = this.layoutOf(tag.type);
      align = Math.max(tagLayout.align, payloadAlign);
      size = alignForward(tagLayout.size + payloadSize, align);
      // Zcu.UnionLayout: the tag first unless the payload is more aligned.
      if (tagLayout.align < payloadAlign) tagOffset = payloadSize;
      else payloadOffset = tagLayout.size;
    }
    const cls: Class = possible === 0 ? 'npv' : comptime ? (payloadSize > 0 ? 'partial' : 'comptime') : tag || payloadSize > 0 ? 'runtime' : 'opv';
    const record = tag
      ? this.taggedUnionRecord(c, fields, payloadOffset, { offset: tagOffset, layout: tagLayout!, type: tag.type, kind: tag.kind }, size, align)
      : this.plainUnionRecord(c, fields, size, align);
    return { size, align, cls, record };
  }

  private packedLayout(c: Container, line?: number): ZLayout {
    const info = this.packedInfo(c, line);
    const l = this.layoutOf(info.backing, line);
    const fields = this.fieldsOf(c);
    const record = this.packedRecord(c, fields, info, l);
    return { size: l.size, align: l.align, cls: info.backingBits === 0 ? 'opv' : 'runtime', record };
  }

  /** Byte or bit offset of a field, as @offsetOf / @bitOffsetOf give it. */
  offsetOf(t: ZType, name: string, bits: boolean, line?: number): number {
    if (t.k !== 'container' || t.c.decl.kind !== 'struct') throw new ZigLayoutError(`'${formatType(t)}' is not a struct.`, line);
    const c = t.c;
    const fields = this.fieldsOf(c);
    const index = fields.findIndex((f) => f.name === name);
    if (index < 0) throw new ZigLayoutError(`'${c.name}' has no field named '${name}'.`, line);
    if (c.decl.layout === 'packed') {
      const off = this.packedInfo(c, line).offsets[index]!;
      return bits ? off : Math.floor(off / 8);
    }
    if (fields[index]!.comptime) throw new ZigLayoutError(`'${name}' is a comptime field: it has no offset.`, line);
    const l = this.containerLayout(c, line);
    const m = l.record!.members.find((x) => x.member.name === name);
    const off = m ? m.offset : 0;
    return bits ? off * 8 : off;
  }

  // ---------------------------------------------------------------- display records

  private memberFor(f: ResolvedField, c: Container): StructMember {
    const member: StructMember = { name: f.name, type: fieldTypeText(this.sourceOf(c), f.decl), line: f.line };
    if (f.type.k === 'container' && f.type.c.decl.kind !== 'opaque') {
      const nested = this.containerLayout(f.type.c, f.line).record;
      if (nested) {
        member.isNested = true;
        member.nestedStruct = nested.struct;
      }
    }
    return member;
  }

  private nestedRecord(t: ZType): CalculationResult | undefined {
    return t.k === 'container' && t.c.decl.kind !== 'opaque' ? t.c.layout?.record : undefined;
  }

  private finish(name: string, members: CalculationResult['members'], size: number, align: number, used: number, extra: Partial<ParsedStruct> = {}): CalculationResult {
    const totalPadding = size - used;
    return {
      struct: { name, members: members.map((m) => m.member), totalSize: size, alignment: align, totalPadding, ...extra },
      members,
      totalSize: size,
      totalPadding,
      wastedSpace: totalPadding,
      efficiency: size > 0 ? ((size - totalPadding) / size) * 100 : 100,
      architecture: this.target.id,
      ...(isBigEndian(this.target) && { bigEndian: true }),
    };
  }

  private structRecord(c: Container, placed: readonly { f: ResolvedField; offset: number; align: number }[], size: number, align: number): CalculationResult {
    const members: CalculationResult['members'] = [];
    let end = 0;
    let used = 0;
    for (const p of placed) {
      const l = this.layoutOf(p.f.type, p.f.line);
      members.push({
        member: this.memberFor(p.f, c),
        offset: p.offset,
        size: l.size,
        padding: Math.max(0, p.offset - end),
        alignment: p.align,
        nested: this.nestedRecord(p.f.type),
      });
      end = Math.max(end, p.offset + l.size);
      used += l.size;
    }
    return this.finish(c.name, members, size, align, used, { line: c.decl.line });
  }

  private plainUnionRecord(c: Container, fields: readonly ResolvedField[], size: number, align: number): CalculationResult {
    const members = fields.map((f) => {
      const l = this.layoutOf(f.type, f.line);
      return { member: this.memberFor(f, c), offset: 0, size: l.size, padding: 0, alignment: f.align ?? l.align, nested: this.nestedRecord(f.type) };
    });
    const used = Math.max(0, ...members.map((m) => m.size));
    return this.finish(c.name, members, size, align, used, { isUnion: true, line: c.decl.line });
  }

  /** A tagged union as its fields overlapping, each with the tag: as Rust enums are shown. */
  private taggedUnionRecord(
    c: Container,
    fields: readonly ResolvedField[],
    payloadOffset: number,
    tag: { offset: number; layout: ZLayout; type: ZType; kind: 'tagged' | 'safety' },
    size: number,
    align: number,
  ): CalculationResult {
    const tagName = tag.kind === 'safety' ? '(safety tag)' : '(tag)';
    const variants = fields.map((f) => {
      const l = this.layoutOf(f.type, f.line);
      const parts = [
        { name: tagName, type: formatType(tag.type), offset: tag.offset, size: tag.layout.size, align: tag.layout.align, member: undefined as StructMember | undefined, nested: undefined as CalculationResult | undefined },
        { name: f.name, type: fieldTypeText(this.sourceOf(c), f.decl), offset: payloadOffset, size: l.size, align: f.align ?? l.align, member: this.memberFor(f, c), nested: this.nestedRecord(f.type) },
      ].sort((a, b) => a.offset - b.offset);
      const members: CalculationResult['members'] = [];
      let end = 0;
      for (const p of parts) {
        if (p.size === 0 && p.member === undefined) continue;
        members.push({
          member: p.member ?? { name: p.name, type: p.type },
          offset: p.offset,
          size: p.size,
          padding: Math.max(0, p.offset - end),
          alignment: p.align,
          nested: p.nested,
        });
        end = Math.max(end, p.offset + p.size);
      }
      const used = members.reduce((s, m) => s + m.size, 0);
      const record = this.finish(f.name, members, size, align, used, { line: f.line });
      return { name: f.name, record, line: f.line };
    });
    const members: CalculationResult['members'] = variants.map((v) => {
      const member: StructMember = { name: v.name, type: 'variant', isNested: true, nestedStruct: v.record.struct, line: v.line };
      const extent = Math.max(0, ...v.record.members.map((m) => m.offset + m.size));
      return { member, offset: 0, size: extent, padding: 0, alignment: v.record.struct.alignment ?? 1, nested: v.record };
    });
    const used = Math.max(0, ...variants.map((v) => v.record.members.reduce((s, m) => s + m.size, 0)));
    return this.finish(c.name, members, size, align, used, { isUnion: true, isEnum: true, line: c.decl.line });
  }

  private enumRecord(c: Container, info: { tag: ZType }, l: ZLayout): CalculationResult {
    const members: CalculationResult['members'] = l.size > 0 ? [{ member: { name: '(tag)', type: formatType(info.tag) }, offset: 0, size: l.size, padding: 0, alignment: l.align }] : [];
    return this.finish(c.name, members, l.size, l.align, l.size, { line: c.decl.line });
  }

  private packedRecord(c: Container, fields: readonly ResolvedField[], info: { backingBits: number; offsets: number[] }, l: ZLayout): CalculationResult {
    const big = isBigEndian(this.target);
    const isUnion = c.decl.kind === 'union';
    const members: CalculationResult['members'] = fields.map((f, i) => {
      const bits = this.bitSize(f.type, f.line);
      const at = info.offsets[i]!;
      // Bit `b` of the backing integer, in memory order: from each byte's least significant bit on
      // a little-endian target; on a big-endian one the integer's last byte comes first.
      const memBit = (b: number) => (big ? (l.size - 1 - Math.floor(b / 8)) * 8 + (7 - (b % 8)) : b);
      const first = bits === 0 ? memBit(at) : big ? memBit(at + bits - 1) : at;
      const offset = Math.floor(first / 8);
      const size = bits === 0 ? 0 : Math.floor((first + bits - 1) / 8) - offset + 1;
      const member = this.memberFor(f, c);
      member.bitField = bits;
      return { member, offset, size, padding: 0, alignment: 1, bitOffset: first, nested: this.nestedRecord(f.type) };
    });
    members.sort((a, b) => a.bitOffset! - b.bitOffset!);
    return this.finish(c.name, members, l.size, l.align, Math.ceil(info.backingBits / 8), { isUnion, line: c.decl.line });
  }
}

// ------------------------------------------------------------------ analysis

export type ZigDefinitionKind = 'struct' | 'union' | 'enum' | 'tuple';

export interface ZigAnalysis {
  target: ZigTarget;
  mode: ZigBuildMode;
  /** --error-limit: error codes have log2 of it plus one bits. */
  errorLimit: number;
  file: ZigFile;
  errors: ParseError[];
  warnings: ParseError[];
  definition: {
    name: string;
    kind: ZigDefinitionKind;
    layout: 'auto' | 'extern' | 'packed';
    line: number;
    /** The declaration's container in the source, for rewriting it. */
    decl: ContainerDecl;
  } | null;
  result: CalculationResult | null;
  /** An extern struct's fields in the order Zig would give a plain struct, when that is smaller. */
  optimized: CalculationResult | null;
  optimizedOrder: string[] | null;
  /** Size of ?T. */
  optionalSize: number | null;
  /** A union's tag: written (`union(enum)`) or the hidden safety tag. */
  unionTag: { kind: 'tagged' | 'safety'; type: string; offset: number; size: number } | null;
  /** A packed container's backing integer. */
  packedBacking: string | null;
  /** An enum's tag type. */
  enumTag: string | null;
  /** A struct's fields as @offsetOf gives them (and @bitOffsetOf for a packed struct). */
  offsets: Array<{ name: string; offset: number; bitOffset?: number }>;
  /** comptime fields: no space at runtime. */
  comptimeFields: string[];
  /** The CPU model the layout is for (`-mcpu`). */
  cpu: ZigCpu;
  unusedTypes: string[];
}

/** Top-level declarations that may be the type to lay out, last first. */
function candidates(file: ZigFile): Decl[] {
  const isImport = (e: Expr | undefined): boolean => {
    if (!e) return false;
    if (e.k === 'builtin' && e.name === '@import') return true;
    if (e.k === 'field') return isImport(e.obj);
    return false;
  };
  return file.root.decls
    .filter((d) => d.kind === 'const' && d.value && !isImport(d.value) && (d.value.k === 'container' || d.value.k === 'call' || d.value.k === 'ident' || d.value.k === 'field'))
    .reverse();
}

/** The build settings a layout depends on: -O, -mcpu and --error-limit. */
export interface ZigBuildOptions {
  mode?: ZigBuildMode;
  cpu?: string;
  errorLimit?: number;
}

export function analyzeZig(code: string, targetId: string, build: ZigBuildOptions = {}): ZigAnalysis {
  const mode = build.mode ?? 'Debug';
  const cpuId = build.cpu;
  const target = getZigTarget(targetId);
  const file = parseZig(code);
  const analysis: ZigAnalysis = {
    target,
    mode,
    errorLimit: build.errorLimit ?? DEFAULT_ERROR_LIMIT,
    file,
    errors: [...file.errors],
    warnings: [...file.warnings],
    definition: null,
    result: null,
    optimized: null,
    optimizedOrder: null,
    optionalSize: null,
    unionTag: null,
    packedBacking: null,
    enumTag: null,
    offsets: [],
    comptimeFields: [],
    cpu: getZigCpu(target, cpuId),
    unusedTypes: [],
  };
  if (analysis.errors.length > 0) return analysis;
  if (file.root.fields.length > 0) {
    analysis.errors.push({ message: 'Fields at the top level make the file itself a struct; declare the struct with a name instead: const Example = struct { ... };', line: file.root.fields[0]!.line, type: 'semantic' });
    return analysis;
  }

  const engine = new ZigEngine(target, file, { mode, cpu: cpuId, errorLimit: build.errorLimit });
  let root: { decl: Decl; c: Container } | undefined;
  let firstError: ZigLayoutError | undefined;
  for (const d of candidates(file)) {
    try {
      const v = engine.eval({ k: 'ident', name: d.name, line: d.line }, engine.rootScope);
      if (v.k === 'type' && v.t.k === 'container' && v.t.c.decl.kind !== 'opaque') {
        root = { decl: d, c: v.t.c };
        break;
      }
    } catch (err) {
      if (!(err instanceof ZigLayoutError) && !(err instanceof NestingError)) throw err;
      if (d.value!.k === 'container') {
        analysis.errors.push({ message: err.message, line: err.line ?? d.line, type: 'semantic' });
        return analysis;
      }
      firstError ??= err;
    }
  }
  if (!root) {
    if (firstError) {
      analysis.errors.push({ message: firstError.message, line: firstError.line, type: 'semantic' });
      return analysis;
    }
    const generic = file.root.decls.find((d) => d.kind === 'fn' && d.fn!.ret.k === 'ident' && d.fn!.ret.name === 'type');
    analysis.errors.push({
      message: generic
        ? `'${generic.name}' returns a type, so it has no layout until it is called. Add a declaration that calls it, e.g. const Example = ${generic.name}(u32);`
        : 'No struct, union or enum found. Declare one, e.g. const Example = struct { a: u8, b: u32 };',
      type: 'semantic',
    });
    return analysis;
  }

  const { c } = root;
  const kind: ZigDefinitionKind = c.tuple ? 'tuple' : (c.decl.kind as 'struct' | 'union' | 'enum');
  analysis.definition = { name: root.decl.name, kind, layout: c.decl.layout, line: root.decl.line, decl: c.decl };
  try {
    const layout = engine.containerLayout(c, root.decl.line);
    if (layout.cls === 'comptime' || layout.cls === 'partial') {
      throw new ZigLayoutError(`'${root.decl.name}' is comptime-only (a field holds a type, comptime_int or function body), so it has no runtime layout.`, root.decl.line);
    }
    analysis.result = layout.record ?? null;
    analysis.optionalSize = engine.layoutOf({ k: 'opt', child: { k: 'container', c } }).size;
    const fields = engine.fieldsOf(c);
    analysis.comptimeFields = fields.filter((f) => f.comptime).map((f) => f.name);
    if (c.decl.kind === 'struct') {
      const self: ZType = { k: 'container', c };
      analysis.offsets = fields
        .filter((f) => !f.comptime)
        .map((f) => ({
          name: f.name,
          offset: engine.offsetOf(self, f.name, false),
          ...(c.decl.layout === 'packed' && { bitOffset: engine.offsetOf(self, f.name, true) }),
        }));
    }
    if (c.decl.kind === 'enum') analysis.enumTag = formatType(engine.enumInfo(c).tag);
    if (c.decl.layout === 'packed') analysis.packedBacking = `u${engine.packedBits(c)}`;
    const tag = engine.unionTag(c);
    if (tag && analysis.result) {
      const first = analysis.result.members[0]?.nested?.members.find((m) => m.member.name === '(tag)' || m.member.name === '(safety tag)');
      analysis.unionTag = { kind: tag.kind, type: formatType(tag.type), offset: first?.offset ?? 0, size: engine.layoutOf(tag.type).size };
    }

    // extern structs keep declaration order; suggest the order Zig gives a plain struct.
    if (c.decl.kind === 'struct' && c.decl.layout === 'extern' && !c.tuple && fields.length > 1 && analysis.result) {
      const auto = engine.containerLayout(engine.variant(c, { layout: 'auto' }));
      const order = auto.record!.members.map((m) => m.member.name);
      if (auto.size < analysis.result.totalSize) {
        const reordered = engine.variant(c, { fields: order.map((n) => c.decl.fields.find((f) => f.name === n)!) });
        analysis.optimizedOrder = order;
        analysis.optimized = engine.containerLayout(reordered).record!;
      }
    }
    analysis.unusedTypes = findUnused(file, root.decl);
  } catch (err) {
    if (!(err instanceof ZigLayoutError) && !(err instanceof NestingError)) throw err;
    analysis.errors.push({ message: err.message, line: err.line, type: 'semantic' });
    analysis.result = null;
  }
  return analysis;
}

/** Top-level container declarations the root does not reach by name. */
function findUnused(file: ZigFile, root: Decl): string[] {
  const decls = new Map(file.root.decls.map((d) => [d.name, d]));
  const used = new Set<string>([root.name]);
  // Declarations go on a worklist: a chain of them can be any length.
  const pending: Decl[] = [];
  const visitExpr = (e: Expr | undefined): void => {
    if (!e) return;
    switch (e.k) {
      case 'ident': {
        const d = decls.get(e.name);
        if (d && !used.has(e.name)) {
          used.add(e.name);
          pending.push(d);
        }
        return;
      }
      case 'field':
        visitExpr(e.obj);
        return;
      case 'call':
        visitExpr(e.fn);
        e.args.forEach(visitExpr);
        return;
      case 'builtin':
        e.args.forEach(visitExpr);
        return;
      case 'unary':
      case 'comptime':
      case 'deref':
      case 'unwrap':
        visitExpr(e.e);
        return;
      case 'binary':
        visitExpr(e.l);
        visitExpr(e.r);
        return;
      case 'optional':
        visitExpr(e.child);
        return;
      case 'errorUnion':
        visitExpr(e.set);
        visitExpr(e.payload);
        return;
      case 'pointer':
        visitExpr(e.child);
        visitExpr(e.align);
        visitExpr(e.sentinel);
        return;
      case 'array':
        visitExpr(e.child);
        if (e.len !== 'infer') visitExpr(e.len);
        return;
      case 'container':
        visitContainer(e.c);
        return;
      case 'fnType':
        e.params.forEach((p) => visitExpr(p.type));
        visitExpr(e.ret);
        return;
      case 'if':
        visitExpr(e.cond);
        visitExpr(e.then);
        visitExpr(e.else);
        return;
      case 'switch':
        visitExpr(e.subject);
        for (const p of e.prongs) {
          for (const item of p.items) {
            if ('value' in item) visitExpr(item.value);
            else {
              visitExpr(item.from);
              visitExpr(item.to);
            }
          }
          visitExpr(p.body);
        }
        return;
      case 'index':
        visitExpr(e.obj);
        visitExpr(e.index);
        return;
      default:
        return;
    }
  };
  const visitStmt = (s: Stmt): void => {
    switch (s.k) {
      case 'decl':
        visitDecl(s.decl);
        return;
      case 'return':
        visitExpr(s.e);
        return;
      case 'if':
        visitExpr(s.cond);
        visitStmt(s.then);
        if (s.else) visitStmt(s.else);
        return;
      case 'block':
        s.body.forEach(visitStmt);
        return;
      case 'expr':
        visitExpr(s.e);
        return;
    }
  };
  const visitDecl = (d: Decl): void => {
    visitExpr(d.type);
    visitExpr(d.value);
    if (d.fn) {
      d.fn.params.forEach((p) => visitExpr(p.type));
      visitExpr(d.fn.ret);
      d.fn.body?.forEach(visitStmt);
    }
  };
  const visitContainer = (c: ContainerDecl): void => {
    visitExpr(c.arg);
    visitExpr(c.unionEnumArg);
    for (const f of c.fields) {
      visitExpr(f.type);
      visitExpr(f.align);
    }
    // Declarations inside a container are used only if referenced; their names are not top-level.
  };
  visitDecl(root);
  while (pending.length > 0) visitDecl(pending.pop()!);
  return file.root.decls.filter((d) => d.kind === 'const' && d.value?.k === 'container' && !used.has(d.name)).map((d) => d.name);
}
