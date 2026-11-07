/**
 * Go constant expressions, typed the way go/types types them (spec: "Constant expressions",
 * "Conversions", "Representability", "Built-in functions", "Package unsafe"): untyped and typed
 * constants, implicit conversion of untyped operands, representability and overflow checks after
 * every operation, shifts, iota, conversions, len/cap/min/max/real/imag/complex, and
 * unsafe.Sizeof/Alignof/Offsetof, which depend on the target's layout.
 *
 * Non-constant expressions are typed as far as unsafe.Sizeof and len need: composite literals,
 * conversions, variables of a known type, &x, *p, x.f, new(T).
 */
import type { Nesting } from '../nesting';
import { decodeGoRune, decodeGoString, utf8 } from './lexer';
import { formatGoExpr } from './parser';
import type { GoConstDecl, GoExpr, GoType, GoVarDecl } from './parser';
import {
  ConstError,
  bitLen,
  formatConst,
  parseFloatLiteral,
  parseIntLiteral,
  ratFromInt,
  realAdd,
  realCompare,
  realMul,
  realNeg,
  realQuo,
  realSub,
  realToIEEE,
  toComplex,
  toInt,
  toReal,
} from './constant';
import type { ConstValue, Real } from './constant';

export type BasicKind =
  | 'bool' | 'string'
  | 'int' | 'int8' | 'int16' | 'int32' | 'int64'
  | 'uint' | 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'uintptr'
  | 'float32' | 'float64' | 'complex64' | 'complex128'
  | 'unsafe.Pointer';

export type UntypedKind = 'bool' | 'int' | 'rune' | 'float' | 'complex' | 'string';

/** A type written somewhere: the scope gives its names their meaning. */
export interface TypeRef<S = unknown> {
  type: GoType;
  scope: S;
}

/** A type as the evaluator sees it. */
export interface Typ {
  /** Identity: two types are identical when their keys are. */
  key: string;
  display: string;
  untyped?: UntypedKind;
  /** The basic type underlying a typed type. */
  basic?: BasicKind;
  /** A type parameter. */
  param?: boolean;
  /** The type itself (typed types). */
  ref?: TypeRef;
  /** Its underlying type when that is a type literal (array, pointer, struct...). */
  under?: TypeRef;
}

export type Operand =
  | { mode: 'constant'; type: Typ; value: ConstValue }
  | { mode: 'value'; type: Typ; composite?: boolean }
  | { mode: 'type'; type: Typ }
  | { mode: 'builtin'; name: string }
  | { mode: 'package'; path: string; name: string }
  | { mode: 'nil' };

export type Entity =
  | { kind: 'const'; decl: GoConstDecl }
  | { kind: 'var'; decl: GoVarDecl }
  | { kind: 'type'; ref: TypeRef }
  | { kind: 'builtin'; name: string }
  | { kind: 'package'; path: string }
  | { kind: 'true' } | { kind: 'false' } | { kind: 'iota' } | { kind: 'nil' };

/** What the evaluator needs from the layout engine. */
export interface EvalHost {
  readonly wordSize: number;
  /** How deeply the types and expressions being worked out are nested (nesting.ts). */
  readonly nesting: Nesting;
  /** The universe scope: predeclared names only. */
  readonly universe: unknown;
  lookup(name: string, scope: unknown): Entity | undefined;
  /** A name in a standard package: unsafe's built-ins, or a built-in std type. */
  lookupQualified(path: string, name: string): Entity | undefined;
  typeOf(ref: TypeRef, line?: number): Typ;
  constant(decl: GoConstDecl, line?: number): Operand;
  variable(decl: GoVarDecl, line?: number): Typ;
  sizeof(ref: TypeRef, line?: number): number;
  alignof(ref: TypeRef, line?: number): number;
  arrayLength(ref: TypeRef, line?: number): number;
  /** Whether the type is or contains (in arrays and structs) a type parameter. */
  variableSize(ref: TypeRef): boolean;
  /** Field `name` of a struct type (promoted fields included), with its offset. */
  field(ref: TypeRef, name: string, line?: number): { ref: TypeRef; offset: number; indirect: boolean } | 'ambiguous' | undefined;
}

export class EvalError extends Error {
  constructor(message: string, public line?: number) {
    super(message);
  }
}

const UNTYPED: Record<UntypedKind, Typ> = {
  bool: { key: 'untyped bool', display: 'untyped bool', untyped: 'bool' },
  int: { key: 'untyped int', display: 'untyped int', untyped: 'int' },
  rune: { key: 'untyped rune', display: 'untyped rune', untyped: 'rune' },
  float: { key: 'untyped float', display: 'untyped float', untyped: 'float' },
  complex: { key: 'untyped complex', display: 'untyped complex', untyped: 'complex' },
  string: { key: 'untyped string', display: 'untyped string', untyped: 'string' },
};

const INTEGER_KINDS = new Set<string>(['int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr']);
const UNSIGNED_KINDS = new Set<string>(['uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr']);

const isUntyped = (t: Typ) => t.untyped !== undefined;
const isBoolean = (t: Typ) => t.untyped === 'bool' || t.basic === 'bool';
const isString = (t: Typ) => t.untyped === 'string' || t.basic === 'string';
const isInteger = (t: Typ) => t.untyped === 'int' || t.untyped === 'rune' || (!!t.basic && INTEGER_KINDS.has(t.basic));
const isUnsigned = (t: Typ) => !!t.basic && UNSIGNED_KINDS.has(t.basic);
const isFloat = (t: Typ) => t.untyped === 'float' || t.basic === 'float32' || t.basic === 'float64';
const isComplex = (t: Typ) => t.untyped === 'complex' || t.basic === 'complex64' || t.basic === 'complex128';
const isNumeric = (t: Typ) => isInteger(t) || isFloat(t) || isComplex(t);
const isOrdered = (t: Typ) => isInteger(t) || isFloat(t) || isString(t);
/** A type constants can have: a boolean, numeric or string basic type underneath. */
const isConstType = (t: Typ) => !!t.basic && t.basic !== 'unsafe.Pointer';
const hasNil = (t: Typ) =>
  t.basic === 'unsafe.Pointer' || (!!t.under && ['pointer', 'slice', 'map', 'chan', 'func', 'interface'].includes(t.under.type.kind));

/** The value's kind, ordered as go/constant's match orders representations. */
const NUM_ORDER = { int: 0, float: 1, complex: 2 } as const;
type NumValue = Extract<ConstValue, { kind: 'int' | 'float' | 'complex' }>;
type Part = Extract<ConstValue, { kind: 'int' | 'float' }>;

const realOf = (v: Part): Real => (v.kind === 'int' ? ratFromInt(v.value) : v.value);
const zeroInt: Part = { kind: 'int', value: 0n };

function sign(v: ConstValue): number {
  switch (v.kind) {
    case 'int':
      return v.value > 0n ? 1 : v.value < 0n ? -1 : 0;
    case 'float':
      return realCompare(v.value, ratFromInt(0n));
    case 'complex':
      return sign(v.re) | sign(v.im);
    default:
      return 0;
  }
}

/** go/constant's match: both values in the larger representation. */
function match(x: NumValue, y: NumValue): [NumValue, NumValue] {
  const to = (v: NumValue, kind: NumValue['kind']): NumValue => {
    if (v.kind === kind) return v;
    if (kind === 'float') return { kind: 'float', value: realOf(v as Part) };
    return v.kind === 'complex' ? v : { kind: 'complex', re: v as Part, im: zeroInt };
  };
  const kind = NUM_ORDER[x.kind] >= NUM_ORDER[y.kind] ? x.kind : y.kind;
  return [to(x, kind), to(y, kind)];
}

function partOp(x: Part, op: string, y: Part): Part {
  return numOp(x, op, y) as Part;
}

/** go/constant.BinaryOp on numbers; '/' is exact division, 'quo_int' integer division. */
function numOp(x0: NumValue, op: string, y0: NumValue): NumValue {
  const [x, y] = match(x0, y0);
  if (x.kind === 'int' && y.kind === 'int') {
    const a = x.value;
    const b = y.value;
    switch (op) {
      case '+': return { kind: 'int', value: a + b };
      case '-': return { kind: 'int', value: a - b };
      case '*': return { kind: 'int', value: a * b };
      case '/': return { kind: 'float', value: realQuo(ratFromInt(a), ratFromInt(b)) };
      case 'quo_int': return { kind: 'int', value: a / b };
      case '%': return { kind: 'int', value: a % b };
      case '&': return { kind: 'int', value: a & b };
      case '|': return { kind: 'int', value: a | b };
      case '^': return { kind: 'int', value: a ^ b };
      case '&^': return { kind: 'int', value: a & ~b };
    }
  } else if (x.kind === 'float' && y.kind === 'float') {
    switch (op) {
      case '+': return { kind: 'float', value: realAdd(x.value, y.value) };
      case '-': return { kind: 'float', value: realSub(x.value, y.value) };
      case '*': return { kind: 'float', value: realMul(x.value, y.value) };
      case '/': return { kind: 'float', value: realQuo(x.value, y.value) };
    }
  } else if (x.kind === 'complex' && y.kind === 'complex') {
    const { re: a, im: b } = x;
    const { re: c, im: d } = y;
    switch (op) {
      case '+': return { kind: 'complex', re: partOp(a, '+', c), im: partOp(b, '+', d) };
      case '-': return { kind: 'complex', re: partOp(a, '-', c), im: partOp(b, '-', d) };
      case '*':
        return {
          kind: 'complex',
          re: partOp(partOp(a, '*', c), '-', partOp(b, '*', d)),
          im: partOp(partOp(b, '*', c), '+', partOp(a, '*', d)),
        };
      case '/': {
        // (ac+bd)/s + i(bc-ad)/s, with s = cc + dd
        const s = partOp(partOp(c, '*', c), '+', partOp(d, '*', d));
        return {
          kind: 'complex',
          re: partOp(partOp(partOp(a, '*', c), '+', partOp(b, '*', d)), '/', s),
          im: partOp(partOp(partOp(b, '*', c), '-', partOp(a, '*', d)), '/', s),
        };
      }
    }
  }
  throw new ConstError(`invalid operation: operator ${op} not defined on ${formatConst(x0)}`);
}

function compareValues(x: ConstValue, op: string, y: ConstValue): boolean {
  let c: number;
  if (x.kind === 'bool' && y.kind === 'bool') {
    c = x.value === y.value ? 0 : 1;
  } else if (x.kind === 'string' && y.kind === 'string') {
    c = 0;
    for (let i = 0; i < Math.min(x.bytes.length, y.bytes.length) && c === 0; i++) c = Math.sign(x.bytes[i] - y.bytes[i]);
    if (c === 0) c = Math.sign(x.bytes.length - y.bytes.length);
  } else {
    const [a, b] = match(x as NumValue, y as NumValue);
    if (a.kind === 'complex' && b.kind === 'complex') {
      c = compareValues(a.re, '==', b.re) && compareValues(a.im, '==', b.im) ? 0 : 1;
    } else if (a.kind === 'int' && b.kind === 'int') {
      c = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    } else {
      c = realCompare(realOf(a as Part), realOf(b as Part));
    }
  }
  switch (op) {
    case '==': return c === 0;
    case '!=': return c !== 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    default: return c >= 0;
  }
}

/** The value of `x` in `scope`; `iota` is the ConstSpec's index inside a constant declaration. */
export function evalGoExpr(host: EvalHost, x: GoExpr, scope: unknown, iota: number | undefined, line?: number): Operand {
  return new Evaluation(host, scope, iota, line).expr(x);
}

/** go/types arrayLength: the length of `[x]T`, a non-negative constant representable by int. */
export function evalGoArrayLength(host: EvalHost, x: GoExpr, scope: unknown, line?: number): number {
  return new Evaluation(host, scope, undefined, line).arrayLength(x);
}

/** A constant declaration's value (spec: "Constant declarations"). */
export function evalGoConstDecl(host: EvalHost, decl: GoConstDecl, scope: unknown): Operand {
  return new Evaluation(host, scope, decl.iota, decl.line).constDecl(decl);
}

/** One evaluation: its scope, iota, and whether it contains calls or receives (for len). */
class Evaluation {
  /** go/types hasCallOrRecv. */
  private callOrRecv = false;

  constructor(
    private host: EvalHost,
    private scope: unknown,
    private iota: number | undefined,
    private line: number | undefined,
  ) {}

  private err(message: string): never {
    throw new EvalError(message, this.line);
  }

  private constant(type: Typ, value: ConstValue): Operand {
    return this.overflow({ mode: 'constant', type, value }, this.line);
  }

  private typeOperand(type: GoType): Operand {
    return { mode: 'type', type: this.host.typeOf({ type, scope: this.scope }, this.line) };
  }

  private sizeBits(t: Typ): number {
    switch (t.basic) {
      case 'int8': case 'uint8': return 8;
      case 'int16': case 'uint16': return 16;
      case 'int32': case 'uint32': return 32;
      case 'int64': case 'uint64': return 64;
      default: return this.host.wordSize * 8;
    }
  }

  private basicTyp(name: string): Typ {
    return this.host.typeOf({ type: { kind: 'name', name }, scope: this.host.universe });
  }

  /** The default type of an untyped constant (spec: "Constants"). */
  private defaultType(t: Typ): Typ {
    switch (t.untyped) {
      case 'bool': return this.basicTyp('bool');
      case 'int': return this.basicTyp('int');
      case 'rune': return this.basicTyp('rune');
      case 'float': return this.basicTyp('float64');
      case 'complex': return this.basicTyp('complex128');
      case 'string': return this.basicTyp('string');
      default: return t;
    }
  }

  /**
   * go/types representableConst: whether v is representable by the basic type, and the value
   * rounded to it (floats to float32/float64, integers as integers).
   */
  private represent(v: ConstValue, t: Typ): ConstValue | undefined {
    if (isInteger(t)) {
      const x = toInt(v);
      if (x === undefined) return undefined;
      if (t.untyped) return { kind: 'int', value: x };
      const bits = this.sizeBits(t);
      const ok = isUnsigned(t) ? x >= 0n && bitLen(x) <= bits : -(1n << BigInt(bits - 1)) <= x && x <= (1n << BigInt(bits - 1)) - 1n;
      return ok ? { kind: 'int', value: x } : undefined;
    }
    if (isFloat(t)) {
      const x = toReal(v);
      if (x === undefined) return undefined;
      if (t.untyped) return { kind: 'float', value: x };
      const r = realToIEEE(x, t.basic === 'float32' ? 32 : 64);
      return r === 'inf' ? undefined : { kind: 'float', value: r };
    }
    if (isComplex(t)) {
      const x = toComplex(v);
      if (x === undefined) return undefined;
      if (t.untyped) return v.kind === 'complex' ? v : { kind: 'complex', re: v as Part, im: zeroInt };
      const bits = t.basic === 'complex64' ? 32 : 64;
      const re = realToIEEE(x.re, bits);
      const im = realToIEEE(x.im, bits);
      if (re === 'inf' || im === 'inf') return undefined;
      return { kind: 'complex', re: { kind: 'float', value: re }, im: { kind: 'float', value: im } };
    }
    if (isString(t)) return v.kind === 'string' ? v : undefined;
    if (isBoolean(t)) return v.kind === 'bool' ? v : undefined;
    return undefined;
  }

  /** go/types representable: the constant in type t, or an error. */
  private representable(x: Extract<Operand, { mode: 'constant' }>, t: Typ, line?: number): ConstValue {
    const v = this.represent(x.value, t);
    if (v) return v;
    const what = `${formatConst(x.value)} (${isUntyped(x.type) ? `${x.type.display} constant` : `constant of type ${x.type.display}`})`;
    if (isNumeric(x.type) && isNumeric(t)) {
      if (!isInteger(x.type) && isInteger(t)) throw new EvalError(`${what} truncated to ${t.display}`, line);
      throw new EvalError(`${what} overflows ${t.display}`, line);
    }
    throw new EvalError(`cannot convert ${what} to type ${t.display}`, line);
  }

  /** go/types overflow: typed results must be representable, untyped integers within 512 bits. */
  private overflow(x: Extract<Operand, { mode: 'constant' }>, line?: number): Operand {
    if (!isUntyped(x.type)) return { ...x, value: this.representable(x, x.type, line) };
    if (x.value.kind === 'int' && bitLen(x.value.value) > 512) throw new EvalError('constant overflow', line);
    if (x.value.kind === 'string' && x.value.bytes.length > 2e9) throw new EvalError('constant string too long', line);
    return x;
  }

  /** go/types implicitTypeAndValue / convertUntyped: an untyped operand given type `target`. */
  private convertUntyped(x: Operand, target: Typ, line?: number): Operand {
    if (x.mode === 'nil') {
      if (target.untyped || !hasNil(target)) throw new EvalError(`cannot use nil as ${target.display} value`, line);
      return x;
    }
    if ((x.mode !== 'constant' && x.mode !== 'value') || !isUntyped(x.type)) return x;
    if (isUntyped(target)) {
      if (isNumeric(x.type) && isNumeric(target)) {
        const order: UntypedKind[] = ['int', 'rune', 'float', 'complex'];
        return order.indexOf(x.type.untyped!) >= order.indexOf(target.untyped!) ? x : { ...x, type: target };
      }
      if (x.type.key === target.key) return x;
      throw new EvalError(`mismatched types ${x.type.display} and ${target.display}`, line);
    }
    if (target.basic) {
      if (x.mode === 'constant') return { mode: 'constant', type: target, value: this.representable(x, target, line) };
      const ok =
        (x.type.untyped === 'bool' && isBoolean(target)) ||
        (isNumeric(x.type) && isNumeric(target)) ||
        (x.type.untyped === 'string' && isString(target));
      if (!ok) throw new EvalError(`cannot use ${x.type.display} value as ${target.display} value`, line);
      return { mode: 'value', type: target };
    }
    if (target.under?.type.kind === 'interface') return { ...x, type: this.defaultType(x.type) };
    throw new EvalError(`cannot use ${x.mode === 'constant' ? formatConst(x.value) : 'value'} (${x.type.display}) as ${target.display} value`, line);
  }

  /** go/types matchTypes: an untyped operand takes the other operand's type. */
  private matchTypes(x: Operand, y: Operand, line?: number): [Operand, Operand] {
    const typed = (o: Operand) => (o.mode === 'constant' || o.mode === 'value') && !isUntyped(o.type);
    if (typed(x) && typed(y)) return [x, y];
    const t = (o: Operand) => (o.mode === 'constant' || o.mode === 'value' ? o.type : undefined);
    const tx = t(x);
    const ty = t(y);
    // nil keeps its untyped type (go.dev/issue/13061); the comparison checks it.
    if (x.mode === 'nil' || y.mode === 'nil') return [x, y];
    if (!tx || !ty) return [x, y];
    if (isBoolean(tx) !== isBoolean(ty) || isString(tx) !== isString(ty)) return [x, y];
    if (tx.under?.type.kind === 'pointer' || ty.under?.type.kind === 'pointer') return [x, y];
    return [this.convertUntyped(x, ty, line), this.convertUntyped(y, tx, line)];
  }

  private describe(x: Operand): string {
    switch (x.mode) {
      case 'constant': return `${formatConst(x.value)} (${isUntyped(x.type) ? `${x.type.display} constant` : `constant of type ${x.type.display}`})`;
      case 'value': return `value of type ${x.type.display}`;
      case 'type': return `type ${x.type.display}`;
      case 'builtin': return `built-in ${x.name}`;
      case 'package': return `package ${x.name}`;
      case 'nil': return 'nil';
    }
  }

  private valueOperand(x: Operand, line?: number): Extract<Operand, { mode: 'constant' | 'value' }> {
    if (x.mode === 'constant' || x.mode === 'value') return x;
    if (x.mode === 'nil') throw new EvalError('use of untyped nil', line);
    throw new EvalError(`${this.describe(x)} is not an expression`, line);
  }

  // ------------------------------------------------------------------ expressions

  /** go/types arrayLength: a non-negative constant representable by int. */
  arrayLength(x: GoExpr): number {
    const line = this.line;
    if (x.kind === 'ident') {
      const e = this.host.lookup(x.name, this.scope);
      if (!e) throw new EvalError(`undefined array length ${x.name} or missing type constraint`, line);
      if (e.kind !== 'const' && e.kind !== 'iota') throw new EvalError(`invalid array length ${x.name}`, line);
    }
    const v = this.expr(x);
    const text = formatGoExpr(x);
    if (v.mode !== 'constant') {
      throw new EvalError(`array length ${text} (${this.describe(v)}) must be constant`, line);
    }
    if (isUntyped(v.type) || isInteger(v.type)) {
      const n = toInt(v.value);
      if (n !== undefined && this.represent({ kind: 'int', value: n }, this.basicTyp('int')) && n >= 0n) {
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new EvalError(`array length ${text} is too large for the calculator`, line);
        return Number(n);
      }
    }
    throw new EvalError(`${isInteger(v.type) ? 'invalid array length' : 'array length'} ${text} (${this.describe(v)})${isInteger(v.type) ? '' : ' must be integer'}`, line);
  }

  /** A constant declaration's value (spec: "Constant declarations"). */
  constDecl(decl: GoConstDecl): Operand {
    const scope = this.scope;
    const x = this.expr(decl.expr);
    if (x.mode !== 'constant') throw new EvalError(`${formatGoExpr(decl.expr)} (${this.describe(x)}) is not constant`, decl.line);
    if (!decl.type) return x;
    const t = this.host.typeOf({ type: decl.type, scope }, decl.line);
    if (!isConstType(t)) throw new EvalError(`invalid constant type ${t.display}`, decl.line);
    if (isUntyped(x.type)) return { mode: 'constant', type: t, value: this.representableAssign(x, t, decl) };
    if (x.type.key !== t.key) {
      throw new EvalError(`cannot use ${formatGoExpr(decl.expr)} (${this.describe(x)}) as ${t.display} value in constant declaration`, decl.line);
    }
    return x;
  }

  private representableAssign(x: Extract<Operand, { mode: 'constant' }>, t: Typ, decl: GoConstDecl): ConstValue {
    const kindOk =
      (x.type.untyped === 'bool' && isBoolean(t)) || (x.type.untyped === 'string' && isString(t)) || (isNumeric(x.type) && isNumeric(t));
    if (!kindOk) throw new EvalError(`cannot use ${formatGoExpr(decl.expr)} (${this.describe(x)}) as ${t.display} value in constant declaration`, decl.line);
    return this.representable(x, t, decl.line);
  }

  expr(x: GoExpr): Operand {
    try {
      return this.host.nesting.in(() => this.expr0(x), this.line);
    } catch (err) {
      if (err instanceof ConstError) this.err(err.message);
      throw err;
    }
  }

  private expr0(x: GoExpr): Operand {
    switch (x.kind) {
      case 'lit':
        return this.literal(x);
      case 'ident':
        return this.ident(x.name);
      case 'paren':
        return this.expr(x.x);
      case 'type':
        return this.typeOperand(x.type);
      case 'selector':
        return this.selector(x);
      case 'index':
        return this.index(x);
      case 'star': {
        const o = this.expr(x.x);
        if (o.mode === 'type') return this.typeOperand({ kind: 'pointer', elem: o.type.ref!.type });
        const v = this.valueOperand(o, this.line);
        if (v.type.under?.type.kind !== 'pointer') this.err(`invalid operation: cannot indirect ${this.describe(v)}`);
        const p = v.type.under!.type as Extract<GoType, { kind: 'pointer' }>;
        return { mode: 'value', type: this.host.typeOf({ type: p.elem, scope: v.type.under!.scope }, this.line) };
      }
      case 'unary':
        return this.unary(x);
      case 'binary':
        return this.binary(x);
      case 'call':
        return this.call(x);
      case 'composite':
        return this.composite(x);
      case 'funclit':
        return { mode: 'value', type: this.host.typeOf({ type: x.type, scope: this.scope }, this.line) };
      case 'keyvalue': case 'ellipsis':
        return this.err(`unexpected ${formatGoExpr(x)}`);
      case 'slice': {
        const v = this.valueOperand(this.expr(x.x), this.line);
        if (isString(v.type)) return { mode: 'value', type: isUntyped(v.type) ? this.basicTyp('string') : v.type };
        if (v.type.under?.type.kind === 'slice') return { mode: 'value', type: v.type };
        const arr = this.arrayOf(v.type);
        if (!arr) this.err(`cannot slice ${this.describe(v)}`);
        const elem = (arr!.type as Extract<GoType, { kind: 'array' }>).elem;
        return { mode: 'value', type: this.host.typeOf({ type: { kind: 'slice', elem }, scope: arr!.scope }, this.line) };
      }
      case 'assert': {
        this.valueOperand(this.expr(x.x), this.line);
        if (!x.type) this.err('use of .(type) outside type switch');
        return { mode: 'value', type: this.host.typeOf({ type: x.type!, scope: this.scope }, this.line) };
      }
    }
  }

  /** The array type underlying t, or the one t points to. */
  private arrayOf(t: Typ): TypeRef | undefined {
    let u = t.under;
    if (u?.type.kind === 'pointer') u = this.host.typeOf({ type: u.type.elem, scope: u.scope }, this.line).under;
    return u?.type.kind === 'array' ? u : undefined;
  }

  private literal(x: Extract<GoExpr, { kind: 'lit' }>): Operand {
    switch (x.tok) {
      case 'int':
        return this.constant(UNTYPED.int, { kind: 'int', value: parseIntLiteral(x.value) });
      case 'float':
        return this.constant(UNTYPED.float, { kind: 'float', value: parseFloatLiteral(x.value) });
      case 'imag': {
        const body = x.value.slice(0, -1);
        // Spec: "for backward-compatibility, an imaginary literal's integer part consisting
        // entirely of decimal digits (and possibly underscores) is considered a decimal integer".
        const im: Part = /^[0-9_]+$/.test(body)
          ? { kind: 'int', value: BigInt(body.replace(/_/g, '')) }
          : /^0[xXbBoO]/.test(body) && !/[.pP]/.test(body)
            ? { kind: 'int', value: parseIntLiteral(body) }
            : { kind: 'float', value: parseFloatLiteral(body) };
        return this.constant(UNTYPED.complex, { kind: 'complex', re: zeroInt, im });
      }
      case 'char':
        return this.constant(UNTYPED.rune, { kind: 'int', value: BigInt(decodeGoRune(x.value)) });
      case 'str':
        return this.constant(UNTYPED.string, { kind: 'string', bytes: decodeGoString(x.value) });
    }
  }

  private entity(e: Entity, name: string): Operand {
    switch (e.kind) {
      case 'const':
        return this.host.constant(e.decl, this.line);
      case 'var':
        return { mode: 'value', type: this.host.variable(e.decl, this.line) };
      case 'type':
        return { mode: 'type', type: this.host.typeOf(e.ref, this.line) };
      case 'builtin':
        return { mode: 'builtin', name: e.name };
      case 'package':
        return { mode: 'package', path: e.path, name };
      case 'true': case 'false':
        return { mode: 'constant', type: UNTYPED.bool, value: { kind: 'bool', value: e.kind === 'true' } };
      case 'iota':
        if (this.iota === undefined) this.err('cannot use iota outside constant declaration');
        return { mode: 'constant', type: UNTYPED.int, value: { kind: 'int', value: BigInt(this.iota!) } };
      case 'nil':
        return { mode: 'nil' };
    }
  }

  private ident(name: string): Operand {
    if (name === '_') this.err('cannot use _ as value');
    const e = this.host.lookup(name, this.scope);
    if (!e) this.err(`undefined: ${name}`);
    return this.entity(e!, name);
  }

  private selector(x: Extract<GoExpr, { kind: 'selector' }>): Operand {
    if (x.x.kind === 'ident') {
      const base = this.host.lookup(x.x.name, this.scope);
      if (base?.kind === 'package') {
        const e = this.host.lookupQualified(base.path, x.sel);
        if (!e) this.err(`undefined: ${x.x.name}.${x.sel} (the calculator knows only some standard-library names)`);
        return this.entity(e!, `${x.x.name}.${x.sel}`);
      }
    }
    const o = this.expr(x.x);
    if (o.mode === 'type') this.err(`method expressions such as ${formatGoExpr(x)} are not supported`);
    const v = this.valueOperand(o, this.line);
    const f = this.field(v.type, x.sel);
    return { mode: 'value', type: this.host.typeOf(f.ref, this.line) };
  }

  /** Field selection x.f, through one implicit pointer indirection. */
  private field(t: Typ, name: string): { ref: { type: GoType; scope: unknown }; offset: number; indirect: boolean } {
    let base = t;
    let deref = false;
    if (t.under?.type.kind === 'pointer') {
      base = this.host.typeOf({ type: t.under.type.elem, scope: t.under.scope }, this.line);
      deref = true;
    }
    if (!base.ref || base.under?.type.kind !== 'struct') this.err(`${t.display} has no field ${name}`);
    const f = this.host.field(base.ref!, name, this.line);
    if (f === 'ambiguous') this.err(`ambiguous selector .${name}`);
    if (!f) this.err(`${t.display} has no field ${name} (the calculator does not know methods)`);
    return { ...(f as Exclude<typeof f, 'ambiguous' | undefined>), indirect: (f as { indirect: boolean }).indirect || deref };
  }

  private index(x: Extract<GoExpr, { kind: 'index' }>): Operand {
    const o = this.expr(x.x);
    if (o.mode === 'type') {
      // A generic type instantiation G[A, B].
      const t = o.type.ref!.type;
      if (t.kind !== 'name') this.err(`${o.type.display} is not a generic type`);
      const args = x.indices.map((i) => this.asType(i));
      return this.typeOperand({ ...(t as Extract<GoType, { kind: 'name' }>), typeArgs: args });
    }
    const v = this.valueOperand(o, this.line);
    if (x.indices.length !== 1) this.err(`unexpected comma; expecting ]`);
    const i = this.expr(x.indices[0]);
    if (isString(v.type)) {
      if (v.mode === 'constant' && i.mode === 'constant') {
        const n = toInt(i.value);
        if (n === undefined || n < 0n || n >= BigInt((v.value as Extract<ConstValue, { kind: 'string' }>).bytes.length)) this.err(`invalid argument: index ${formatConst(i.value)} out of bounds`);
      }
      // Spec: "a constant index of a constant string is a non-constant byte value".
      return { mode: 'value', type: this.basicTyp('byte') };
    }
    const u = v.type.under;
    let elem: { type: GoType; scope: unknown } | undefined;
    if (u?.type.kind === 'array' || u?.type.kind === 'slice') elem = { type: u.type.elem, scope: u.scope };
    else if (u?.type.kind === 'map') elem = { type: u.type.value, scope: u.scope };
    else if (u?.type.kind === 'pointer') {
      const p = this.host.typeOf({ type: u.type.elem, scope: u.scope }, this.line).under;
      if (p?.type.kind === 'array') elem = { type: p.type.elem, scope: p.scope };
    }
    if (!elem) this.err(`invalid operation: cannot index ${this.describe(v)}`);
    return { mode: 'value', type: this.host.typeOf(elem!, this.line) };
  }

  /** An expression that must denote a type (type arguments, new, make). */
  private asType(x: GoExpr): GoType {
    const o = this.expr(x);
    if (o.mode !== 'type') this.err(`${formatGoExpr(x)} is not a type`);
    return (o as Extract<Operand, { mode: 'type' }>).type.ref!.type;
  }

  private unary(x: Extract<GoExpr, { kind: 'unary' }>): Operand {
    if (x.op === '&') {
      const o = this.valueOperand(this.expr(x.x), this.line);
      let inner: GoExpr = x.x;
      while (inner.kind === 'paren') inner = inner.x;
      if (inner.kind !== 'composite' && o.mode === 'constant') this.err(`invalid operation: cannot take address of ${this.describe(o)}`);
      if (!o.type.ref) this.err(`invalid operation: cannot take address of ${this.describe(o)}`);
      return { mode: 'value', type: this.host.typeOf({ type: { kind: 'pointer', elem: o.type.ref!.type }, scope: o.type.ref!.scope }, this.line) };
    }
    if (x.op === '<-') {
      const o = this.valueOperand(this.expr(x.x), this.line);
      this.callOrRecv = true;
      const u = o.type.under;
      if (u?.type.kind !== 'chan') this.err(`invalid operation: cannot receive from non-channel ${this.describe(o)}`);
      return { mode: 'value', type: this.host.typeOf({ type: (u!.type as Extract<GoType, { kind: 'chan' }>).elem, scope: u!.scope }, this.line) };
    }
    const o = this.valueOperand(this.expr(x.x), this.line);
    const ok = x.op === '!' ? isBoolean(o.type) : x.op === '^' ? isInteger(o.type) : isNumeric(o.type);
    if (!ok) this.err(`invalid operation: operator ${x.op} not defined on ${this.describe(o)}`);
    if (o.mode !== 'constant') return { mode: 'value', type: o.type };
    const v = o.value;
    let value: ConstValue;
    switch (x.op) {
      case '+':
        value = v;
        break;
      case '-':
        value =
          v.kind === 'int' ? { kind: 'int', value: -v.value }
            : v.kind === 'float' ? { kind: 'float', value: realNeg(v.value) }
              : numOp({ kind: 'int', value: 0n }, '-', v as NumValue);
        break;
      case '^': {
        // go/constant.UnaryOp(XOR, v, prec): ^v, masked to the size of unsigned types.
        let r = ~(v as Extract<ConstValue, { kind: 'int' }>).value;
        if (isUnsigned(o.type)) r &= (1n << BigInt(this.sizeBits(o.type))) - 1n;
        value = { kind: 'int', value: r };
        break;
      }
      default:
        value = { kind: 'bool', value: !(v as Extract<ConstValue, { kind: 'bool' }>).value };
    }
    return this.constant(o.type, value);
  }

  private binary(x: Extract<GoExpr, { kind: 'binary' }>): Operand {
    const lx = this.valueOperand(this.expr(x.x), this.line);
    if (x.op === '<<' || x.op === '>>') return this.shift(lx, this.valueOperand(this.expr(x.y), this.line), x.op);
    let a: Operand = lx;
    let b: Operand = this.expr(x.y);
    if (b.mode !== 'nil') b = this.valueOperand(b, this.line);
    [a, b] = this.matchTypes(a, b, this.line);
    const va = this.valueOperand(a, this.line);
    const vb = this.valueOperand(b, this.line);
    const text = formatGoExpr(x);
    if (['==', '!=', '<', '<=', '>', '>='].includes(x.op)) {
      if (va.type.key !== vb.type.key) this.err(`invalid operation: ${text} (mismatched types ${va.type.display} and ${vb.type.display})`);
      const ordered = x.op !== '==' && x.op !== '!=';
      if (ordered && !isOrdered(va.type)) this.err(`invalid operation: ${text} (operator ${x.op} not defined on ${this.describe(va)})`);
      if (va.mode === 'constant' && vb.mode === 'constant') {
        return { mode: 'constant', type: UNTYPED.bool, value: { kind: 'bool', value: compareValues(va.value, x.op, vb.value) } };
      }
      return { mode: 'value', type: UNTYPED.bool };
    }
    if (va.type.key !== vb.type.key) this.err(`invalid operation: ${text} (mismatched types ${va.type.display} and ${vb.type.display})`);
    const t = va.type;
    const allowed =
      x.op === '+' ? isNumeric(t) || isString(t)
        : x.op === '-' || x.op === '*' || x.op === '/' ? isNumeric(t)
          : x.op === '&&' || x.op === '||' ? isBoolean(t)
            : isInteger(t);
    if (!allowed) this.err(`invalid operation: operator ${x.op} not defined on ${this.describe(va)}`);
    if ((x.op === '/' || x.op === '%') && (va.mode === 'constant' || isInteger(t)) && vb.mode === 'constant') {
      if (sign(vb.value) === 0) this.err('invalid operation: division by zero');
      if (va.mode === 'constant' && isComplex(t)) {
        const c = toComplex(vb.value)!;
        if (sign({ kind: 'float', value: realAdd(realMul(c.re, c.re), realMul(c.im, c.im)) }) === 0) this.err('invalid operation: division by zero');
      }
    }
    if (va.mode !== 'constant' || vb.mode !== 'constant') return { mode: 'value', type: t };
    let value: ConstValue;
    if (x.op === '&&' || x.op === '||') {
      const p = (va.value as Extract<ConstValue, { kind: 'bool' }>).value;
      const q = (vb.value as Extract<ConstValue, { kind: 'bool' }>).value;
      value = { kind: 'bool', value: x.op === '&&' ? p && q : p || q };
    } else if (va.value.kind === 'string') {
      value = { kind: 'string', bytes: [...va.value.bytes, ...(vb.value as Extract<ConstValue, { kind: 'string' }>).bytes] };
    } else {
      // go/types: "force integer division" of integer operands.
      const op = x.op === '/' && isInteger(t) ? 'quo_int' : x.op;
      value = numOp(va.value as NumValue, op, vb.value as NumValue);
    }
    return this.constant(t, value);
  }

  /** go/types shift. */
  private shift(x: Extract<Operand, { mode: 'constant' | 'value' }>, y: Extract<Operand, { mode: 'constant' | 'value' }>, op: string): Operand {
    const xval = x.mode === 'constant' ? toInt(x.value) : undefined;
    if (!(isInteger(x.type) || (isUntyped(x.type) && xval !== undefined))) {
      this.err(`invalid operation: shifted operand ${this.describe(x)} must be integer`);
    }
    let count: bigint | undefined;
    if (y.mode === 'constant') {
      const yval = toInt(y.value);
      if (yval !== undefined && yval < 0n) this.err(`invalid operation: negative shift count ${this.describe(y)}`);
      if (isUntyped(y.type)) {
        count = toInt(this.representable(y, this.basicTyp('uint'), this.line));
      } else {
        if (!isInteger(y.type)) this.err(`invalid operation: shift count ${this.describe(y)} must be integer`);
        count = yval;
      }
    } else if (!isInteger(y.type) && !isUntyped(y.type)) {
      this.err(`invalid operation: shift count ${this.describe(y)} must be integer`);
    }
    if (x.mode === 'constant' && y.mode === 'constant') {
      // "rhs must be within reasonable bounds in constant shifts"
      const shiftBound = 1023n - 1n + 52n;
      if (count === undefined || count > shiftBound) this.err(`invalid operation: invalid shift count ${this.describe(y)}`);
      const type = isInteger(x.type) ? x.type : UNTYPED.int;
      const value = op === '<<' ? xval! << count! : xval! >> count!;
      return this.constant(type, { kind: 'int', value });
    }
    if (x.mode === 'constant' && isUntyped(x.type)) {
      // Spec: the constant takes the type it would have without the shift; here, its default.
      return { mode: 'value', type: this.defaultType(x.type) };
    }
    if (!isInteger(x.type)) this.err(`invalid operation: shifted operand ${this.describe(x)} must be integer`);
    return { mode: 'value', type: x.type };
  }

  private composite(x: Extract<GoExpr, { kind: 'composite' }>): Operand {
    if (!x.type) this.err('invalid composite literal type: missing type');
    let type: GoType;
    const t = x.type!;
    if (t.kind === 'type' && t.type.kind === 'array' && t.type.length.kind === 'ellipsis') {
      // [...]T{...}: the length is the largest index plus one.
      let n = 0n;
      let max = 0n;
      for (const e of x.elems) {
        if (e.kind === 'keyvalue') {
          const k = this.expr(e.key);
          if (k.mode !== 'constant') this.err('index must be non-negative integer constant');
          const i = toInt((k as Extract<Operand, { mode: 'constant' }>).value);
          if (i === undefined || i < 0n) this.err('index must be non-negative integer constant');
          n = i!;
        }
        n += 1n;
        if (n > max) max = n;
      }
      type = { kind: 'array', length: { kind: 'lit', tok: 'int', value: max.toString() }, elem: t.type.elem };
    } else {
      type = this.asType(t);
    }
    // go/types type-checks the elements: calls and receives in them make len(T{...}) non-constant.
    for (const e of x.elems) this.scanCalls(e.kind === 'keyvalue' ? e.value : e);
    const typ = this.host.typeOf({ type, scope: this.scope }, this.line);
    const k = typ.under?.type.kind;
    if (k !== 'array' && k !== 'slice' && k !== 'map' && k !== 'struct') this.err(`invalid composite literal type ${typ.display}`);
    return { mode: 'value', type: typ, composite: true };
  }

  /** Marks calls and receives in a composite literal element (go/types hasCallOrRecv). */
  private scanCalls(e: GoExpr): void {
    const visit = (x: GoExpr): void => {
      switch (x.kind) {
        case 'call': {
          let fun: Operand | undefined;
          try {
            fun = this.expr(x.fun);
          } catch {
            fun = undefined;
          }
          if (fun?.mode === 'type') {
            x.args.forEach(visit);
            return;
          }
          if (fun?.mode === 'builtin') {
            try {
              if (this.expr(x).mode === 'constant') return;
            } catch {
              // Not evaluable here: counts as a call.
            }
          }
          this.callOrRecv = true;
          return;
        }
        case 'unary':
          if (x.op === '<-') this.callOrRecv = true;
          visit(x.x);
          return;
        case 'binary':
          visit(x.x);
          visit(x.y);
          return;
        case 'paren': case 'star': case 'selector': case 'assert':
          visit(x.x);
          return;
        case 'index':
          visit(x.x);
          x.indices.forEach(visit);
          return;
        case 'slice':
          visit(x.x);
          x.indices.forEach((i) => i && visit(i));
          return;
        case 'composite':
          x.elems.forEach(visit);
          return;
        case 'keyvalue':
          visit(x.key);
          visit(x.value);
          return;
        default:
          return;
      }
    };
    visit(e);
  }

  private call(x: Extract<GoExpr, { kind: 'call' }>): Operand {
    const f = this.expr(x.fun);
    if (f.mode === 'type') {
      if (x.args.length !== 1 || x.ellipsis) this.err(`wrong number of arguments in conversion to ${f.type.display}`);
      return this.conversion(this.expr(x.args[0]), f.type);
    }
    if (f.mode === 'builtin') return this.builtin(f.name, x);
    const v = this.valueOperand(f, this.line);
    this.callOrRecv = true;
    const sig = v.type.under?.type;
    if (sig?.kind !== 'func') this.err(`invalid operation: cannot call non-function ${this.describe(v)}`);
    const s = sig as Extract<GoType, { kind: 'func' }>;
    if (s.results.length !== 1) this.err(`${formatGoExpr(x)} (no value or multiple values) used as value`);
    return { mode: 'value', type: this.host.typeOf({ type: s.results[0], scope: v.type.under!.scope }, this.line) };
  }

  /** go/types conversion (spec: "Conversions"). */
  private conversion(arg: Operand, t: Typ): Operand {
    if (arg.mode === 'nil') {
      if (!hasNil(t) && !t.param) this.err(`cannot convert nil to type ${t.display}`);
      return { mode: 'value', type: t };
    }
    const x = this.valueOperand(arg, this.line);
    if (x.mode === 'constant' && isConstType(t)) {
      const v = this.represent(x.value, t);
      if (v) return { mode: 'constant', type: t, value: v };
      if (isInteger(x.type) && isString(t)) {
        // string(rune): the UTF-8 encoding, or "�" for an invalid code point.
        const i = toInt(x.value)!;
        const code = i >= 0n && i <= 0x10ffffn && !(i >= 0xd800n && i < 0xe000n) ? Number(i) : 0xfffd;
        return { mode: 'constant', type: t, value: { kind: 'string', bytes: utf8(code) } };
      }
      if (isInteger(x.type) && isInteger(t)) this.err(`cannot convert ${this.describe(x)} to type ${t.display}: constant ${formatConst(x.value)} overflows ${t.display}`);
      this.err(`cannot convert ${this.describe(x)} to type ${t.display}`);
    }
    // A non-constant conversion (or of a constant to a non-constant type, a type parameter...).
    return { mode: 'value', type: t };
  }

  private builtin(name: string, x: Extract<GoExpr, { kind: 'call' }>): Operand {
    const n = x.args.length;
    const want = (lo: number, hi = lo) => {
      if (n < lo) this.err(`not enough arguments for ${formatGoExpr(x)}`);
      if (n > hi) this.err(`too many arguments for ${formatGoExpr(x)}`);
    };
    if (x.ellipsis && name !== 'append') this.err(`invalid operation: invalid use of ... with built-in ${name}`);
    const value = (i: number) => this.valueOperand(this.expr(x.args[i]), this.line);
    const intTyp = () => this.basicTyp('int');
    const uintptrTyp = () => this.basicTyp('uintptr');
    switch (name) {
      case 'len': case 'cap': {
        want(1);
        const outer = this.callOrRecv;
        this.callOrRecv = false;
        const a = value(0);
        const hasCall = this.callOrRecv;
        this.callOrRecv = outer || hasCall;
        if (isString(a.type) && name === 'len') {
          if (a.mode === 'constant') {
            return { mode: 'constant', type: intTyp(), value: { kind: 'int', value: BigInt((a.value as Extract<ConstValue, { kind: 'string' }>).bytes.length) } };
          }
          return { mode: 'value', type: intTyp() };
        }
        const u = this.arrayOf(a.type);
        if (u) {
          // Spec: "len(s) and cap(s) are constants if the type of s is an array or pointer to an
          // array and the expression s does not contain channel receives or function calls".
          if (hasCall) return { mode: 'value', type: intTyp() };
          return { mode: 'constant', type: intTyp(), value: { kind: 'int', value: BigInt(this.host.arrayLength(u, this.line)) } };
        }
        const k = a.type.under?.type.kind;
        if (k === 'slice' || k === 'chan' || (k === 'map' && name === 'len') || a.type.param) return { mode: 'value', type: intTyp() };
        return this.err(`invalid argument: ${this.describe(a)} for built-in ${name}`);
      }
      case 'min': case 'max': {
        want(1, Infinity);
        let acc: Operand = value(0);
        const op = name === 'max' ? '>' : '<';
        for (let i = 0; i < n; i++) {
          let a: Operand = i === 0 ? acc : value(i);
          const va = this.valueOperand(a, this.line);
          if (!isOrdered(va.type)) this.err(`invalid argument: ${this.describe(va)} cannot be ordered`);
          if (i === 0) continue;
          [acc, a] = this.matchTypes(acc, a, this.line);
          const p = this.valueOperand(acc, this.line);
          const q = this.valueOperand(a, this.line);
          if (p.type.key !== q.type.key) this.err(`invalid argument: mismatched types ${p.type.display} (previous argument) and ${q.type.display}`);
          if (p.mode === 'constant' && q.mode === 'constant') {
            if (compareValues(q.value, op, p.value)) acc = q;
          } else {
            acc = { mode: 'value', type: p.type };
          }
        }
        const r = this.valueOperand(acc, this.line);
        if (r.mode !== 'constant' && isUntyped(r.type)) return { mode: 'value', type: this.defaultType(r.type) };
        return r;
      }
      case 'real': case 'imag': {
        want(1);
        let a = value(0);
        if (isUntyped(a.type) && a.mode === 'constant' && isNumeric(a.type)) a = { ...a, type: UNTYPED.complex };
        const res = a.type.basic === 'complex64' ? this.basicTyp('float32')
          : a.type.basic === 'complex128' ? this.basicTyp('float64')
            : a.type.untyped === 'complex' ? UNTYPED.float : undefined;
        if (!res) this.err(`invalid argument: ${this.describe(a)}, expected complex type`);
        if (a.mode !== 'constant') return { mode: 'value', type: res! };
        const c = a.value.kind === 'complex' ? a.value : { re: a.value as Part, im: zeroInt };
        return { mode: 'constant', type: res!, value: name === 'real' ? c.re : c.im };
      }
      case 'complex': {
        want(2);
        let a: Operand = value(0);
        let b: Operand = value(1);
        const ua = isUntyped((a as Extract<Operand, { mode: 'value' }>).type);
        const ub = isUntyped((b as Extract<Operand, { mode: 'value' }>).type);
        if (ua && !ub) a = this.convertUntyped(a, (b as Extract<Operand, { mode: 'value' }>).type, this.line);
        else if (ub && !ua) b = this.convertUntyped(b, (a as Extract<Operand, { mode: 'value' }>).type, this.line);
        else if (ua && ub) {
          const toFloat = (o: Operand): Operand => {
            const v = this.valueOperand(o, this.line);
            if (v.mode === 'constant' && isNumeric(v.type) && (v.value.kind !== 'complex' || sign(v.value.im) === 0)) return { ...v, type: UNTYPED.float };
            if (v.mode !== 'constant') return this.convertUntyped(v, this.basicTyp('float64'), this.line);
            return v;
          };
          a = toFloat(a);
          b = toFloat(b);
        }
        const va = this.valueOperand(a, this.line);
        const vb = this.valueOperand(b, this.line);
        if (va.type.key !== vb.type.key) this.err(`invalid operation: ${formatGoExpr(x)} (mismatched types ${va.type.display} and ${vb.type.display})`);
        const res = va.type.basic === 'float32' ? this.basicTyp('complex64')
          : va.type.basic === 'float64' ? this.basicTyp('complex128')
            : va.type.untyped === 'float' ? UNTYPED.complex : undefined;
        if (!res) this.err(`invalid argument: arguments have type ${va.type.display}, expected floating-point`);
        if (va.mode !== 'constant' || vb.mode !== 'constant') return { mode: 'value', type: res! };
        const re = toReal(va.value)!;
        const im = toReal(vb.value)!;
        return this.constant(res!, { kind: 'complex', re: { kind: 'float', value: re }, im: { kind: 'float', value: im } });
      }
      case 'new': {
        want(1);
        const t = this.asType(x.args[0]);
        return { mode: 'value', type: this.host.typeOf({ type: { kind: 'pointer', elem: t }, scope: this.scope }, this.line) };
      }
      case 'make': {
        want(1, 3);
        const t = this.asType(x.args[0]);
        this.callOrRecv = true;
        return { mode: 'value', type: this.host.typeOf({ type: t, scope: this.scope }, this.line) };
      }
      case 'unsafe.Sizeof': case 'unsafe.Alignof': {
        want(1);
        let a: Operand = value(0);
        if (isUntyped((a as Extract<Operand, { mode: 'value' }>).type)) a = { ...a, type: this.defaultType((a as Extract<Operand, { mode: 'value' }>).type) } as Operand;
        const t = (a as Extract<Operand, { mode: 'value' }>).type;
        // Spec: constant "if the argument is a type that doesn't have variable size".
        if (!t.ref || this.host.variableSize(t.ref)) return { mode: 'value', type: uintptrTyp() };
        const size = name === 'unsafe.Sizeof' ? this.host.sizeof(t.ref, this.line) : this.host.alignof(t.ref, this.line);
        return { mode: 'constant', type: uintptrTyp(), value: { kind: 'int', value: BigInt(size) } };
      }
      case 'unsafe.Offsetof': {
        want(1);
        let arg = x.args[0];
        while (arg.kind === 'paren') arg = arg.x;
        if (arg.kind !== 'selector') this.err(`invalid argument: ${formatGoExpr(x.args[0])} is not a selector expression`);
        const sel = arg as Extract<GoExpr, { kind: 'selector' }>;
        const base = this.valueOperand(this.expr(sel.x), this.line);
        const f = this.field(base.type, sel.sel);
        if (f.indirect && base.type.under?.type.kind !== 'pointer') this.err(`invalid argument: field ${sel.sel} is embedded via a pointer in ${formatGoExpr(sel.x)}`);
        if (f.indirect && base.type.under?.type.kind === 'pointer') {
          // (*T)(nil).f: the struct is *s; the field must still be reachable without indirection.
          const inner = this.host.typeOf({ type: (base.type.under.type as Extract<GoType, { kind: 'pointer' }>).elem, scope: base.type.under.scope }, this.line);
          const g = this.host.field(inner.ref!, sel.sel, this.line);
          if (g && g !== 'ambiguous' && g.indirect) this.err(`invalid argument: field ${sel.sel} is embedded via a pointer in ${formatGoExpr(sel.x)}`);
        }
        const structTyp = base.type.under?.type.kind === 'pointer'
          ? this.host.typeOf({ type: (base.type.under.type as Extract<GoType, { kind: 'pointer' }>).elem, scope: base.type.under.scope }, this.line)
          : base.type;
        if (!structTyp.ref || this.host.variableSize(structTyp.ref)) return { mode: 'value', type: uintptrTyp() };
        return { mode: 'constant', type: uintptrTyp(), value: { kind: 'int', value: BigInt(f.offset) } };
      }
      default:
        return this.err(`the built-in ${name} is not supported in constant expressions by the calculator`);
    }
  }
}

