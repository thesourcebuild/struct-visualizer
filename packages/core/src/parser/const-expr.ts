/**
 * Integer constant-expression evaluator (C11 6.6), used for array sizes, bit-field widths,
 * alignment arguments, enum values, static assertions and #if conditions.
 *
 * Operates on tokens after macro expansion. Identifiers are resolved through `identifier` (enum
 * constants); in #if every identifier left is 0, as C says. With `types` (the parser, which knows
 * the target) it also evaluates what needs types: `sizeof`, `_Alignof`, `offsetof`, casts, and
 * the address-of-a-member idioms `&((T *)0)->m` and `sizeof(((T *)0)->m)`. Without it, as in #if,
 * those are an error, as they are for the preprocessor.
 *
 * With `integers` (the target's integer types) the arithmetic is C's: each constant has a type
 * (C11 6.4.4.1, from its value and suffix), operands are promoted and converted to a common type
 * (6.3.1.1, 6.3.1.8), unsigned arithmetic wraps, and an operation whose result does not fit its
 * signed type is no constant (GCC) unless the compiler folds it anyway (`overflow`). Values are
 * exact BigInts. Without `integers` the values are exact integers of no fixed width (Go's
 * untyped constants).
 */
import type { Token } from './tokens';
import { Nesting } from '../nesting';

export class ConstExprError extends Error {}

/** An integer type: rank orders _Bool (0), char (1), short (2), int (3), long (4), long long (5). */
export interface IntType {
  name: string;
  /** Width in bits; 0 for the unbounded integers used without an IntegerModel. */
  bits: number;
  unsigned: boolean;
  rank: number;
  /** _Bool: converting to it gives 0 or 1. */
  bool?: boolean;
}

export type FloatName = 'float' | 'double' | 'long double';

/** What a cast or `typeof` names, as far as arithmetic goes. */
export type ScalarType = { kind: 'int'; type: IntType } | { kind: 'float'; name: FloatName };

/** The target's integer types and how its compiler folds constants. */
export interface IntegerModel {
  /** Widths in bits. */
  short: number;
  int: number;
  long: number;
  longLong: number;
  /**
   * Plain char is signed (x86, MIPS, AVR, MSVC) or unsigned (ARM, AArch64, RISC-V, PowerPC,
   * SDCC); undefined where that is not known, so a value that depends on it is an error.
   */
  charSigned: boolean | undefined;
  /** size_t: the type of sizeof, _Alignof and offsetof. */
  sizeType: 'unsigned int' | 'unsigned long' | 'unsigned long long';
  /** Bytes of the floating types, for sizeof of a floating expression. */
  floatBytes: Record<FloatName, number>;
  /**
   * Signed overflow (and a left shift of a negative value): 'not-constant' (GCC: the expression is
   * no constant, an error where one is required, though an enumerator takes the wrapped value) or
   * 'wrap' (SDCC folds it to the wrapped value).
   */
  overflow: 'not-constant' | 'wrap';
  /**
   * Where the compiler's folding is not ISO C's (measured with SDCC 4.2): 'sdcc' compares with
   * < > <= >= by the operands' values, not after converting them to a common type; types sizeof,
   * _Alignof and offsetof as the smallest of unsigned char, int and long that holds the value; and
   * gives a multi-character constant the value of its first character.
   */
  folding: 'iso' | 'sdcc';
  /**
   * A shift by the operand's width or more (undefined, 6.5.7p3): no constant (GCC), 0 (MSVC), or
   * (SDCC, measured on an x86-64 host) shifted as a 32-bit host value, whose shift count the host
   * takes modulo 32, then converted to the type.
   */
  shiftPastWidth?: 'zero' | 'host32';
}

/** What a constant expression may ask about types; implemented by the parser for the target. */
export interface TypeOracle<T> {
  /** The type-name starting at tokens[start] and the index after it, or undefined if none starts there. */
  typeName(tokens: readonly Token[], start: number): { type: T; end: number } | undefined;
  sizeOf(type: T): number;
  /** `preferred`: GCC's `__alignof__`, which can exceed the ABI alignment `_Alignof` gives. */
  alignOf(type: T, preferred: boolean): number;
  /** Member `name` of a struct or union type: its offset and type. */
  member(type: T, name: string): { offset: number; type: T };
  /** What an array holds or a pointer points to, or undefined for any other type. */
  element(type: T): T | undefined;
  isArray(type: T): boolean;
  isPointer(type: T): boolean;
  /** The arithmetic type `type` is, for a cast to it; throws ConstExprError for any other type. */
  scalar(type: T): ScalarType;
  describe(type: T): string;
}

/** An enumeration constant: its value, and its type where it is not int. */
export type ConstantValue = number | bigint | { value: bigint; type: IntType };

export interface ConstExprContext<T = unknown> {
  /** An identifier left after macro expansion (an enum constant), or undefined if it is not one. */
  identifier?: (name: string) => ConstantValue | undefined;
  types?: TypeOracle<T>;
  integers?: IntegerModel;
  /** An enumerator's value: GCC takes the wrapped value of a signed overflow there (with a warning). */
  allowOverflow?: boolean;
  /** Where the expression is, for messages: '#if', '#pragma pack'. */
  context?: string;
  /** The nesting depth of what contains the expression (a C parser's), which it goes on counting. */
  nesting?: Nesting;
}

/** The type of each integer type name under `model`. */
export function integerType(model: IntegerModel, name: string): IntType {
  const rankOf: Record<string, [number, number]> = {
    _Bool: [0, 8], bool: [0, 8], char: [1, 8], 'signed char': [1, 8], 'unsigned char': [1, 8],
    short: [2, model.short], 'unsigned short': [2, model.short], int: [3, model.int], 'unsigned int': [3, model.int],
    long: [4, model.long], 'unsigned long': [4, model.long], 'long long': [5, model.longLong], 'unsigned long long': [5, model.longLong],
    // GCC's __int128, on the targets that have it.
    __int128: [6, 128], 'unsigned __int128': [6, 128],
  };
  const [rank, bits] = rankOf[name] ?? [3, model.int];
  const unsigned = name.startsWith('unsigned') || rank === 0 || (name === 'char' && model.charSigned === false);
  return { name, bits, unsigned, rank, ...(rank === 0 && { bool: true }) };
}

/** #if: every signed type acts as intmax_t and every unsigned one as uintmax_t (C11 6.10.1p4), 64 bits on every target here. */
export function preprocessorModel(charSigned: boolean | undefined): IntegerModel {
  return {
    short: 64, int: 64, long: 64, longLong: 64, charSigned, sizeType: 'unsigned long',
    floatBytes: { float: 4, double: 8, 'long double': 16 }, overflow: 'not-constant', folding: 'iso',
  };
}

const UNBOUNDED: IntType = { name: 'integer', bits: 0, unsigned: false, rank: 3 };

/** Parse an integer literal's value: decimal, hex, octal, binary, with u/l suffixes. */
export function parseIntegerLiteral(text: string): number | undefined {
  const v = integerLiteral(text);
  return v === undefined ? undefined : Number(v.value);
}

/** An integer constant's value, base and suffix. */
function integerLiteral(text: string): { value: bigint; decimal: boolean; unsigned: boolean; longs: number } | undefined {
  // Digit separators: '_' (Go, Rust) and "'" (C23, C++14).
  const clean = text.replace(/[_']/g, '');
  const suffix = /(?:[uU](?:ll|LL|l|L)?|(?:ll|LL|l|L)[uU]?)$/.exec(clean)?.[0] ?? '';
  const body = clean.slice(0, clean.length - suffix.length);
  const unsigned = /[uU]/.test(suffix);
  const longs = /ll|LL/.test(suffix) ? 2 : /[lL]/.test(suffix) ? 1 : 0;
  let value: bigint;
  if (/^0[xX][0-9a-fA-F]+$/.test(body) || /^0[bB][01]+$/.test(body)) value = BigInt(body);
  else if (/^0[oO][0-7]+$/.test(body)) value = BigInt(`0o${body.slice(2)}`);
  else if (/^0[0-7]*$/.test(body)) value = body.length > 1 ? BigInt(`0o${body.slice(1)}`) : 0n;
  else if (/^[1-9][0-9]*$/.test(body)) value = BigInt(body);
  else return undefined;
  return { value, decimal: /^[1-9]/.test(body), unsigned, longs };
}

/** A floating constant (C11 6.4.4.2): decimal or hexadecimal, with an f or l suffix. */
function floatLiteral(text: string): { value: number; type: FloatName } | undefined {
  const m = /^((?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)[pP][+-]?[0-9]+)([fFlL]?)$/.exec(text);
  if (!m || !/[.eEpP]/.test(m[1]!) || (/^0[xX]/.test(m[1]!) && !/[pP]/.test(m[1]!))) return undefined;
  const type: FloatName = /[fF]/.test(m[2]!) ? 'float' : /[lL]/.test(m[2]!) ? 'long double' : 'double';
  let value: number;
  if (/^0[xX]/.test(m[1]!)) {
    const [, mant, exp] = /^0[xX]([0-9a-fA-F.]*)[pP]([+-]?[0-9]+)$/.exec(m[1]!)!;
    const [int, frac = ''] = mant!.split('.');
    value = (parseInt(`${int || '0'}${frac}`, 16) / 16 ** frac.length) * 2 ** Number(exp);
  } else {
    value = Number(m[1]);
  }
  return { value: type === 'float' ? Math.fround(value) : value, type };
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, '\\': 92, "'": 39, '"': 34, '?': 63, a: 7, b: 8, f: 12, v: 11, e: 27, E: 27 };

/** The bytes a character constant or string literal's contents stand for, or undefined if not modelled. */
function literalBytes(inner: string): number[] | undefined {
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; ) {
    if (inner[i] !== '\\') {
      // A source character outside ASCII is its UTF-8 bytes (GCC's execution character set).
      const cp = inner.codePointAt(i)!;
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      i += cp > 0xffff ? 2 : 1;
      continue;
    }
    const rest = inner.slice(i + 1);
    const oct = /^[0-7]{1,3}/.exec(rest);
    const hex = /^x([0-9a-fA-F]+)/.exec(rest);
    if (oct) {
      bytes.push(parseInt(oct[0], 8) & 0xff);
      i += 1 + oct[0].length;
    } else if (hex) {
      bytes.push(parseInt(hex[1]!.slice(-2), 16));
      i += 1 + hex[0].length;
    } else if (rest[0] !== undefined && rest[0] in ESCAPES) {
      bytes.push(ESCAPES[rest[0]]!);
      i += 2;
    } else {
      return undefined;
    }
  }
  return bytes;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

const ALIGNOF = new Map([['_Alignof', false], ['alignof', false], ['__alignof__', true], ['__alignof', true]]);

/**
 * An operand: an integer or floating value with its type, an address (a pointer constant such as
 * `(T *)0` or `&x.m`), an object at an address, which only `sizeof`, `&`, member access and
 * indexing may use, since reading it is not constant, or a string literal (an array of `bytes`).
 */
type Operand<T> =
  | { kind: 'int'; value: bigint; type: IntType }
  | { kind: 'float'; value: number; type: FloatName }
  | { kind: 'ptr'; pointee: T | undefined; address: number }
  | { kind: 'object'; type: T; address: number; spelled: string }
  | { kind: 'string'; bytes: number };

/** The value of an integer constant expression, with its type. */
export interface IntegerConstant {
  value: bigint;
  type: IntType;
}

/**
 * Evaluate `tokens` as one integer constant expression. Throws ConstExprError with a message
 * naming the offending token when it is not one.
 */
export function evaluateConstExpr<T>(tokens: readonly Token[], ctx: ConstExprContext<T> = {}): number {
  return Number(evaluateIntegerConstExpr(tokens, ctx).value);
}

/** evaluateConstExpr, with the exact value and its type. */
export function evaluateIntegerConstExpr<T>(tokens: readonly Token[], ctx: ConstExprContext<T> = {}): IntegerConstant {
  const o = new Evaluator(tokens, ctx).whole();
  if (o.kind === 'int') return { value: o.value, type: o.type };
  // SDCC takes a floating value where an integer constant is needed (measured: `char a[2.0]`).
  if (o.kind === 'float' && ctx.integers?.folding === 'sdcc' && Number.isFinite(o.value)) {
    return { value: BigInt(Math.trunc(o.value)), type: integerType(ctx.integers, 'int') };
  }
  if (o.kind === 'float') throw new ConstExprError('it has a floating type, not an integer one');
  return new Evaluator(tokens, ctx).integerOf(o);
}

/**
 * The type of an expression, for `typeof`: an object's type, or the arithmetic type of a value
 * (named for `types.typeName`), or a string literal's char array.
 */
export function expressionType<T>(tokens: readonly Token[], ctx: ConstExprContext<T>): { object: T } | { scalar: string } | { string: number } {
  const e = new Evaluator(tokens, ctx);
  e.skipping += 1;
  const o = e.whole();
  if (o.kind === 'object') return { object: o.type };
  if (o.kind === 'int' || o.kind === 'float') return { scalar: o.kind === 'int' ? o.type.name : o.type };
  if (o.kind === 'string') return { string: o.bytes };
  throw new ConstExprError('the type of an address is not modelled; write the pointer type');
}

class Evaluator<T> {
  private pos = 0;
  /** Inside an operand that is not evaluated (sizeof, typeof, the side && || ?: do not take). */
  skipping = 0;
  private readonly m: IntegerModel | undefined;
  private readonly nesting: Nesting;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly ctx: ConstExprContext<T>,
  ) {
    this.m = ctx.integers;
    this.nesting = ctx.nesting ?? new Nesting();
  }

  /** `f`, one level of nesting deeper: a parenthesis, an operator's operand, a type-name. */
  private nested<R>(f: () => R): R {
    return this.nesting.in(f, this.peek()?.line);
  }

  private peek(k = 0): Token | undefined {
    return this.tokens[this.pos + k];
  }
  private isPunct(v: string, k = 0): boolean {
    return this.peek(k)?.kind === 'punct' && this.peek(k)?.value === v;
  }
  private fail(msg: string): never {
    throw new ConstExprError(msg);
  }
  /** An error that depends on a value, which an operand that is not evaluated does not have. */
  private undefinedHere(msg: string): void {
    if (this.skipping === 0) this.fail(msg);
  }
  private types(what: string): TypeOracle<T> {
    return this.ctx.types ?? this.fail(`'${what}' needs types, which ${this.ctx.context ? `${this.ctx.context} does` : 'the preprocessor does'} not know`);
  }
  private expect(v: string, what: string): void {
    if (!this.isPunct(v)) this.fail(`expected '${v}' ${what}${this.peek() ? ` but found '${this.peek()!.value}'` : ''}`);
    this.pos += 1;
  }

  whole(): Operand<T> {
    if (this.tokens.length === 0) this.fail('empty expression');
    const v = this.conditional();
    if (this.pos < this.tokens.length) this.fail(`unexpected '${this.tokens[this.pos]!.value}'`);
    return v;
  }

  // ---------------------------------------------------------------- types and conversions

  private type(name: string): IntType {
    return this.m ? integerType(this.m, name) : UNBOUNDED;
  }

  private fits(value: bigint, t: IntType): boolean {
    if (t.bits === 0) return true;
    return t.unsigned ? value >= 0n && value < 1n << BigInt(t.bits) : value >= -(1n << BigInt(t.bits - 1)) && value < 1n << BigInt(t.bits - 1);
  }

  private wrap(value: bigint, t: IntType): bigint {
    if (t.bool) return value !== 0n ? 1n : 0n;
    if (t.bits === 0) return value;
    return t.unsigned ? BigInt.asUintN(t.bits, value) : BigInt.asIntN(t.bits, value);
  }

  /** Integer promotion (6.3.1.1p2). */
  private promote(t: IntType): IntType {
    if (t.rank >= 3) return t;
    const int = this.type('int');
    return t.bits < int.bits || (t.bits === int.bits && !t.unsigned) ? int : this.type('unsigned int');
  }

  /** The usual arithmetic conversions of two integer types (6.3.1.8). */
  private common(a: IntType, b: IntType): IntType {
    a = this.promote(a);
    b = this.promote(b);
    if (a.unsigned === b.unsigned) return a.rank >= b.rank ? a : b;
    const [u, s] = a.unsigned ? [a, b] : [b, a];
    if (u.rank >= s.rank) return u;
    if (s.bits > u.bits) return s;
    return this.type(`unsigned ${s.name}`);
  }

  /** A signed result that does not fit its type: no constant (GCC), or wrapped (SDCC, enumerators). */
  private signedResult(value: bigint, t: IntType, spelled: string): bigint {
    if (!this.fits(value, t) && this.m?.overflow !== 'wrap' && !this.ctx.allowOverflow) {
      this.undefinedHere(`${spelled} overflows '${t.name}', so it is not a constant`);
    }
    return this.wrap(value, t);
  }

  private int(value: bigint, t: IntType, spelled: string): Operand<T> {
    return { kind: 'int', value: t.unsigned ? this.wrap(value, t) : this.signedResult(value, t, spelled), type: t };
  }

  /** The type of an integer constant (6.4.4.1p5): the first of its candidates that holds it. */
  private literalType(lit: { value: bigint; decimal: boolean; unsigned: boolean; longs: number }, text: string): IntType {
    if (!this.m) return UNBOUNDED;
    const ranks = ['int', 'long', 'long long'].slice(lit.longs);
    const candidates = ranks.flatMap((r) => (lit.unsigned ? [`unsigned ${r}`] : lit.decimal ? [r] : [r, `unsigned ${r}`]));
    for (const name of candidates) if (this.fits(lit.value, this.type(name))) return this.type(name);
    // GCC: a decimal constant too big for long long is unsigned long long ("so large that it is unsigned").
    if (this.fits(lit.value, this.type('unsigned long long'))) return this.type('unsigned long long');
    return this.fail(`'${text}' is too large for any integer type`);
  }

  /** The type sizeof, _Alignof and offsetof give `value`. */
  private sizeResult(value: number): Operand<T> {
    if (this.m?.folding === 'sdcc') {
      const t = ['unsigned char', 'int', 'long'].map((n) => this.type(n)).find((c) => this.fits(BigInt(value), c))!;
      return { kind: 'int', value: BigInt(value), type: t };
    }
    return { kind: 'int', value: BigInt(value), type: this.type(this.m?.sizeType ?? 'unsigned long') };
  }

  integerOf(o: Operand<T>): IntegerConstant {
    if (o.kind === 'int') return { value: o.value, type: o.type };
    if (o.kind === 'float') return this.fail('a floating value is only an integer after a cast to an integer type');
    if (o.kind === 'ptr' || o.kind === 'string') return this.fail('an address is only an integer after a cast to an integer type');
    // An array decays to its address; any other object would be read, which is not constant.
    if (this.ctx.types?.isArray(o.type)) return this.fail('an address is only an integer after a cast to an integer type');
    return this.fail(`'${o.spelled}' reads an object, which a constant expression cannot`);
  }

  /** An arithmetic operand: an integer or floating value. */
  private arithmetic(o: Operand<T>): Extract<Operand<T>, { kind: 'int' | 'float' }> {
    if (o.kind === 'float') return o;
    const i = this.integerOf(o);
    return { kind: 'int', ...i };
  }

  private truth(o: Operand<T>): boolean {
    const a = this.arithmetic(o);
    return a.kind === 'float' ? a.value !== 0 : a.value !== 0n;
  }

  /** `o` converted to `to`, as a cast converts it. */
  private convert(o: Extract<Operand<T>, { kind: 'int' | 'float' }>, to: ScalarType): Operand<T> {
    if (to.kind === 'float') {
      const v = o.kind === 'float' ? o.value : Number(o.value);
      return { kind: 'float', value: to.name === 'float' ? Math.fround(v) : v, type: to.name };
    }
    if (o.kind === 'int') {
      const value = this.wrap(o.value, to.type);
      if (to.type.name === 'char' && this.m && this.m.charSigned === undefined && value !== BigInt.asUintN(8, o.value)) {
        this.fail(`converting ${o.value} to 'char' depends on whether char is signed on this target, which is not known`);
      }
      return { kind: 'int', value, type: to.type };
    }
    if (to.type.bool) return { kind: 'int', value: o.value !== 0 ? 1n : 0n, type: to.type };
    // A floating value converts by truncation; one outside the type's range is undefined (6.3.1.4p1).
    if (!Number.isFinite(o.value)) {
      this.undefinedHere(`${o.value} has no value in '${to.type.name}'`);
      return { kind: 'int', value: 0n, type: to.type };
    }
    const v = BigInt(Math.trunc(o.value));
    if (!this.fits(v, to.type)) this.undefinedHere(`${o.value} is outside the range of '${to.type.name}'`);
    return { kind: 'int', value: this.wrap(v, to.type), type: to.type };
  }

  private floatRank(t: FloatName): number {
    return t === 'float' ? 0 : t === 'double' ? 1 : 2;
  }

  // ---------------------------------------------------------------- objects and addresses

  private decay(o: Operand<T>): Operand<T> {
    if (o.kind === 'object' && this.ctx.types?.isArray(o.type)) return { kind: 'ptr', pointee: this.ctx.types.element(o.type), address: o.address };
    return o;
  }

  /** A type-name in parentheses at pos: `( type )`, consumed; undefined (nothing consumed) if not one. */
  private parenthesizedType(): T | undefined {
    if (!this.ctx.types || !this.isPunct('(')) return undefined;
    const types = this.ctx.types;
    const parsed = this.nested(() => types.typeName(this.tokens, this.pos + 1));
    if (!parsed || this.tokens[parsed.end]?.value !== ')') return undefined;
    this.pos = parsed.end + 1;
    return parsed.type;
  }

  /** `object.name`, or `pointer->name`. */
  private memberOf(o: Operand<T>, name: string, arrow: boolean): Operand<T> {
    const t = this.types(arrow ? '->' : '.');
    let base: { type: T; address: number; spelled: string };
    if (arrow) {
      const p = this.decay(o);
      if (p.kind !== 'ptr' || p.pointee === undefined) return this.fail(`'->${name}' needs a pointer to a struct or union`);
      base = { type: p.pointee, address: p.address, spelled: '' };
    } else {
      if (o.kind !== 'object') return this.fail(`'.${name}' needs a struct or union`);
      base = o;
    }
    const m = t.member(base.type, name);
    return { kind: 'object', type: m.type, address: base.address + m.offset, spelled: `${base.spelled}${arrow ? '->' : '.'}${name}` };
  }

  private indexOf(o: Operand<T>, index: number): Operand<T> {
    const t = this.types('[]');
    const p = this.decay(o);
    if (p.kind !== 'ptr' || p.pointee === undefined) return this.fail("'[]' needs an array or a pointer");
    return { kind: 'object', type: p.pointee, address: p.address + index * t.sizeOf(p.pointee), spelled: `[${index}]` };
  }

  private postfix(o: Operand<T>): Operand<T> {
    for (;;) {
      if (this.isPunct('.') || this.isPunct('->')) {
        const arrow = this.peek()!.value === '->';
        this.pos += 1;
        const name = this.peek();
        if (name?.kind !== 'id') this.fail(`expected a member name after '${arrow ? '->' : '.'}'`);
        this.pos += 1;
        o = this.memberOf(o, name!.value, arrow);
      } else if (this.isPunct('[')) {
        this.pos += 1;
        const index = Number(this.integerOf(this.nested(() => this.conditional())).value);
        this.expect(']', 'to close the subscript');
        o = this.indexOf(o, index);
      } else {
        return o;
      }
    }
  }

  /** `offsetof(type, member-designator)`: stddef.h's macro, which is built in like the header. */
  private offsetOf(): number {
    const t = this.types('offsetof');
    this.expect('(', "after 'offsetof'");
    const parsed = this.nested(() => t.typeName(this.tokens, this.pos)) ?? this.fail("expected a type as offsetof's first argument");
    this.pos = parsed.end;
    this.expect(',', "after offsetof's type");
    let o: Operand<T> = { kind: 'object', type: parsed.type, address: 0, spelled: t.describe(parsed.type) };
    const first = this.peek();
    if (first?.kind !== 'id') this.fail("expected a member name as offsetof's second argument");
    this.pos += 1;
    o = this.postfix(this.memberOf(o, first!.value, false));
    this.expect(')', 'to close offsetof');
    return o.kind === 'object' ? o.address : this.fail('offsetof needs a member');
  }

  private sizeOfOperand(o: Operand<T>, t: TypeOracle<T>): number {
    if (o.kind === 'object') return t.sizeOf(o.type);
    if (o.kind === 'string') return o.bytes;
    if (o.kind === 'int') {
      if (!this.m) return this.fail("'sizeof' of an integer expression needs the target's types");
      return Math.max(1, o.type.bits / 8);
    }
    if (o.kind === 'float') return this.m ? this.m.floatBytes[o.type] : this.fail("'sizeof' of a floating expression needs the target's types");
    return this.fail("'sizeof' of an address is not supported; write the pointer type");
  }

  // ---------------------------------------------------------------- the grammar

  private charConstant(text: string): Operand<T> {
    const int = this.type('int');
    if (!/^'.*'$/s.test(text)) return this.fail(`unsupported character constant ${text}`);
    const bytes = literalBytes(text.slice(1, -1));
    if (!bytes || bytes.length === 0) return this.fail(`unsupported character constant ${text}`);
    const asChar = (b: number) => {
      if (b > 127 && this.m && this.m.charSigned === undefined) this.fail(`${text} depends on whether char is signed on this target, which is not known`);
      return this.m?.charSigned === false ? BigInt(b) : BigInt(b > 127 ? b - 256 : b);
    };
    if (bytes.length === 1) return { kind: 'int', value: asChar(bytes[0]!), type: int };
    // SDCC: the first character. GCC: the bytes in order, as many as an int holds, as an int.
    if (this.m?.folding === 'sdcc') return { kind: 'int', value: asChar(bytes[0]!), type: int };
    const value = bytes.reduce((v, b) => (v << 8n) | BigInt(b), 0n);
    return { kind: 'int', value: int.bits ? BigInt.asIntN(int.bits, value) : value, type: int };
  }

  private primary(): Operand<T> {
    const t = this.peek();
    if (!t) return this.fail('unexpected end of expression');
    if (t.kind === 'num') {
      this.pos += 1;
      const lit = integerLiteral(t.value);
      if (lit) return { kind: 'int', value: lit.value, type: this.literalType(lit, t.value) };
      const f = floatLiteral(t.value);
      if (f && this.ctx.context === '#if') return this.fail('a floating constant is not allowed in #if');
      if (f) return { kind: 'float', value: f.value, type: f.type };
      return this.fail(`'${t.value}' is not a number`);
    }
    if (t.kind === 'char') {
      this.pos += 1;
      return this.charConstant(t.value);
    }
    if (t.kind === 'str') {
      // Adjacent string literals are one array (translation phase 6).
      let bytes = 0;
      while (this.peek()?.kind === 'str') {
        const s = this.peek()!.value;
        const inner = /^"(.*)"$/s.exec(s)?.[1];
        const b = inner === undefined ? undefined : literalBytes(inner);
        if (!b) this.fail(`unsupported string literal ${s}`);
        bytes += b!.length;
        this.pos += 1;
      }
      return { kind: 'string', bytes: bytes + 1 };
    }
    if (t.kind === 'id') {
      if (t.value === 'offsetof' || t.value === '__builtin_offsetof') {
        this.pos += 1;
        return this.sizeResult(this.offsetOf());
      }
      this.pos += 1;
      const v = this.ctx.identifier?.(t.value);
      if (v === undefined) return this.fail(`'${t.value}' is not a known constant`);
      if (typeof v === 'object') return { kind: 'int', value: v.value, type: v.type };
      const value = BigInt(v);
      const int = this.type('int');
      return { kind: 'int', value, type: this.fits(value, int) ? int : this.literalType({ value, decimal: false, unsigned: false, longs: 1 }, t.value) };
    }
    if (t.value === '(') {
      this.pos += 1;
      const v = this.nested(() => this.conditional());
      this.expect(')', 'to close the parenthesis');
      return v;
    }
    return this.fail(`unexpected '${t.value}'`);
  }

  /** An operand that is not evaluated: only its type counts. */
  private unevaluated<R>(f: () => R): R {
    this.skipping += 1;
    try {
      return f();
    } finally {
      this.skipping -= 1;
    }
  }

  private unary(): Operand<T> {
    const t = this.peek();
    if (t?.kind === 'id' && t.value === 'sizeof') {
      this.pos += 1;
      const oracle = this.types('sizeof');
      const type = this.parenthesizedType();
      if (type !== undefined) return this.sizeResult(oracle.sizeOf(type));
      return this.sizeResult(this.sizeOfOperand(this.unevaluated(() => this.nested(() => this.unary())), oracle));
    }
    if (t?.kind === 'id' && ALIGNOF.has(t.value)) {
      this.pos += 1;
      const oracle = this.types(t.value);
      const type = this.parenthesizedType() ?? this.fail(`'${t.value}' needs a type in parentheses`);
      return this.sizeResult(oracle.alignOf(type, ALIGNOF.get(t.value)!));
    }
    if (t?.kind === 'punct') {
      if (t.value === '(') {
        const type = this.parenthesizedType();
        if (type !== undefined) {
          const oracle = this.ctx.types!;
          if (this.isPunct('{')) this.fail('a compound literal is not a constant');
          const operand = this.decay(this.nested(() => this.unary()));
          if (oracle.isPointer(type)) {
            if (operand.kind === 'object') return this.fail(`'${operand.spelled}' reads an object, which a constant expression cannot`);
            const address = operand.kind === 'int' ? Number(operand.value) : operand.kind === 'ptr' ? operand.address : this.fail('only an integer or an address converts to a pointer here');
            return { kind: 'ptr', pointee: oracle.element(type), address };
          }
          const to = oracle.scalar(type);
          if (operand.kind === 'ptr') {
            if (to.kind === 'float') return this.fail('an address does not convert to a floating type');
            return { kind: 'int', value: this.wrap(BigInt(operand.address), to.type), type: to.type };
          }
          return this.convert(this.arithmetic(operand), to);
        }
      }
      if (t.value === '&') {
        this.pos += 1;
        const operand = this.nested(() => this.unary());
        if (operand.kind !== 'object') this.fail("'&' needs an object, such as ((T *)0)->member");
        const o = operand as Extract<Operand<T>, { kind: 'object' }>;
        return { kind: 'ptr', pointee: o.type, address: o.address };
      }
      if (t.value === '*') {
        this.pos += 1;
        const p = this.decay(this.nested(() => this.unary()));
        if (p.kind !== 'ptr' || p.pointee === undefined) this.fail("'*' needs a pointer");
        const q = p as Extract<Operand<T>, { kind: 'ptr' }>;
        return { kind: 'object', type: q.pointee!, address: q.address, spelled: '*' };
      }
      if (t.value === '-' || t.value === '+' || t.value === '~') {
        this.pos += 1;
        const a = this.arithmetic(this.nested(() => this.unary()));
        if (a.kind === 'float') {
          if (t.value === '~') this.fail("'~' needs an integer operand");
          return { kind: 'float', value: t.value === '-' ? -a.value : a.value, type: a.type };
        }
        const type = this.promote(a.type);
        if (t.value === '+') return { kind: 'int', value: a.value, type };
        if (t.value === '~') return { kind: 'int', value: this.wrap(~a.value, type), type };
        return this.int(-a.value, type, `-(${a.value})`);
      }
      if (t.value === '!') {
        this.pos += 1;
        return { kind: 'int', value: this.truth(this.nested(() => this.unary())) ? 0n : 1n, type: this.type('int') };
      }
    }
    return this.postfix(this.primary());
  }

  private binary(minPrec: number): Operand<T> {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const prec = t?.kind === 'punct' ? BINARY_PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.pos += 1;
      const op = t!.value;
      if (op === '&&' || op === '||') {
        // The right operand is evaluated only when the left does not decide (6.5.13, 6.5.14).
        const l = this.truth(left);
        const decided = op === '&&' ? !l : l;
        const right = decided ? this.unevaluated(() => this.binary(prec + 1)) : this.binary(prec + 1);
        const r = decided ? false : this.truth(right);
        left = { kind: 'int', value: (op === '&&' ? l && r : l || r) ? 1n : 0n, type: this.type('int') };
        continue;
      }
      left = this.apply(op, this.arithmetic(left), this.arithmetic(this.binary(prec + 1)));
    }
  }

  private apply(op: string, a: Extract<Operand<T>, { kind: 'int' | 'float' }>, b: Extract<Operand<T>, { kind: 'int' | 'float' }>): Operand<T> {
    const int = this.type('int');
    const bool = (v: boolean): Operand<T> => ({ kind: 'int', value: v ? 1n : 0n, type: int });
    const relational = op === '<' || op === '>' || op === '<=' || op === '>=';
    const compare = (x: number | bigint, y: number | bigint): Operand<T> => {
      switch (op) {
        case '<': return bool(x < y);
        case '>': return bool(x > y);
        case '<=': return bool(x <= y);
        case '>=': return bool(x >= y);
        case '==': return bool(x === y);
        default: return bool(x !== y);
      }
    };

    if (a.kind === 'float' || b.kind === 'float') {
      const type = [a, b].filter((o): o is Extract<Operand<T>, { kind: 'float' }> => o.kind === 'float').map((o) => o.type).reduce((x, y) => (this.floatRank(x) >= this.floatRank(y) ? x : y));
      const x = a.kind === 'float' ? a.value : Number(a.value);
      const y = b.kind === 'float' ? b.value : Number(b.value);
      if (relational || op === '==' || op === '!=') return compare(x, y);
      const r = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : this.fail(`'${op}' needs integer operands`);
      return { kind: 'float', value: type === 'float' ? Math.fround(r) : r, type };
    }

    // SDCC compares with < > <= >= by the values themselves.
    if (relational && this.m?.folding === 'sdcc') return compare(a.value, b.value);

    if (op === '<<' || op === '>>') {
      const type = this.promote(a.type);
      const count = b.value;
      if (type.bits && count >= BigInt(type.bits) && this.m?.shiftPastWidth === 'zero') return { kind: 'int', value: 0n, type };
      if (type.bits && type.bits <= 32 && count >= BigInt(type.bits) && this.m?.shiftPastWidth === 'host32') {
        const host = BigInt.asUintN(32, a.value);
        const shifted = op === '<<' ? BigInt.asUintN(32, host << (count % 32n)) : (type.unsigned ? host : BigInt.asIntN(32, a.value)) >> (count % 32n);
        return { kind: 'int', value: this.wrap(shifted, type), type };
      }
      if (type.bits && (count < 0n || count >= BigInt(type.bits))) {
        this.undefinedHere(`shifting a ${type.bits}-bit '${type.name}' by ${count} is undefined`);
        return { kind: 'int', value: 0n, type };
      }
      if (count < 0n) return this.fail(`a negative shift count (${count})`);
      if (op === '>>') return { kind: 'int', value: a.value >> count, type };
      if (!type.unsigned && a.value < 0n) {
        // Shifting a negative value left is undefined (6.5.7p4): GCC makes it no constant.
        if (this.m?.overflow !== 'wrap' && !this.ctx.allowOverflow) this.undefinedHere(`shifting the negative ${a.value} left is undefined`);
        return { kind: 'int', value: this.wrap(a.value << count, type), type };
      }
      return this.int(a.value << count, type, `${a.value} << ${count}`);
    }

    const type = this.common(a.type, b.type);
    const x = this.wrap(a.value, type);
    const y = this.wrap(b.value, type);
    switch (op) {
      case '<': case '>': case '<=': case '>=': case '==': case '!=':
        return compare(x, y);
      case '&': return { kind: 'int', value: this.wrap(x & y, type), type };
      case '|': return { kind: 'int', value: this.wrap(x | y, type), type };
      case '^': return { kind: 'int', value: this.wrap(x ^ y, type), type };
      case '+': return this.int(x + y, type, `${x} + ${y}`);
      case '-': return this.int(x - y, type, `${x} - ${y}`);
      case '*': return this.int(x * y, type, `${x} * ${y}`);
      case '/':
      case '%':
        if (y === 0n) {
          this.undefinedHere('division by zero');
          return { kind: 'int', value: 0n, type };
        }
        return this.int(op === '/' ? x / y : x % y, type, `${x} ${op} ${y}`);
    }
    return this.fail(`unexpected '${op}'`);
  }

  private conditional(): Operand<T> {
    const cond = this.binary(1);
    if (!this.isPunct('?')) return cond;
    this.pos += 1;
    // Only the operand chosen is evaluated (6.5.15p4); both give the result's type.
    const which = this.truth(cond);
    const branch = () => this.nested(() => this.conditional());
    const whenTrue = which ? branch() : this.unevaluated(branch);
    this.expect(':', 'in the conditional expression');
    const whenFalse = which ? this.unevaluated(branch) : branch();
    const chosen = which ? whenTrue : whenFalse;
    if (whenTrue.kind === 'int' && whenFalse.kind === 'int') {
      const type = this.common(whenTrue.type, whenFalse.type);
      return { kind: 'int', value: this.wrap((chosen as typeof whenTrue).value, type), type };
    }
    if ((whenTrue.kind === 'int' || whenTrue.kind === 'float') && (whenFalse.kind === 'int' || whenFalse.kind === 'float')) {
      const type = [whenTrue, whenFalse].flatMap((o) => (o.kind === 'float' ? [o.type] : [])).reduce((x, y) => (this.floatRank(x) >= this.floatRank(y) ? x : y));
      return this.convert(chosen as Extract<Operand<T>, { kind: 'int' | 'float' }>, { kind: 'float', name: type });
    }
    return chosen;
  }
}
