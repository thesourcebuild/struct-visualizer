/**
 * Integer constant-expression evaluator (C11 6.6), used for array sizes, bit-field widths,
 * alignment arguments, enum values, static assertions and #if conditions.
 *
 * Operates on tokens after macro expansion. Identifiers are resolved through `identifier` (enum
 * constants); in #if every identifier left is 0, as C says. With `types` (the parser, which knows
 * the target) it also evaluates what needs types: `sizeof`, `_Alignof`, `offsetof`, casts, and
 * the address-of-a-member idioms `&((T *)0)->m` and `sizeof(((T *)0)->m)`. Without it, as in #if,
 * those are an error, as they are for the preprocessor.
 */
import type { Token } from './tokens';

export class ConstExprError extends Error {}

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
  /** `value` converted to the integer type `type`, as a cast or assignment converts it. */
  convert(type: T, value: number): number;
  describe(type: T): string;
}

export interface ConstExprContext<T = unknown> {
  /** An identifier left after macro expansion (an enum constant), or undefined if it is not one. */
  identifier?: (name: string) => number | undefined;
  types?: TypeOracle<T>;
  /** Where the expression is, for messages: '#if', '#pragma pack'. */
  context?: string;
}

/** Parse an integer literal: decimal, hex, octal, binary, with u/l suffixes, or a char literal. */
export function parseIntegerLiteral(text: string): number | undefined {
  // Digit separators: '_' (Go, Rust) and "'" (C23, C++14).
  const body = text.replace(/[_']/g, '').replace(/(?:[uU](?:ll|LL|l|L)?|(?:ll|LL|l|L)[uU]?)$/, '');
  if (/^0[xX][0-9a-fA-F]+$/.test(body)) return parseInt(body.slice(2), 16);
  if (/^0[bB][01]+$/.test(body)) return parseInt(body.slice(2), 2);
  if (/^0[oO][0-7]+$/.test(body)) return parseInt(body.slice(2), 8);
  if (/^0[0-7]*$/.test(body)) return parseInt(body, 8);
  if (/^[1-9][0-9]*$/.test(body)) return parseInt(body, 10);
  return undefined;
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34, '?': 63, a: 7, b: 8, f: 12, v: 11 };

function charLiteralValue(text: string): number | undefined {
  const inner = text.slice(1, -1);
  if (inner.length === 1) return inner.charCodeAt(0);
  if (inner.length === 2 && inner[0] === '\\' && inner[1] in ESCAPES) return ESCAPES[inner[1]];
  const hex = /^\\x([0-9a-fA-F]{1,2})$/.exec(inner);
  if (hex) return parseInt(hex[1], 16);
  const oct = /^\\([0-7]{1,3})$/.exec(inner);
  if (oct) return parseInt(oct[1], 8);
  return undefined;
}

/** Bytes in a narrow string literal's array, its terminating 0 included. */
function stringLiteralSize(text: string): number | undefined {
  if (!text.startsWith('"')) return undefined; // L"", u8"" and friends are separate tokens here
  const inner = text.slice(1, -1);
  let count = 0;
  for (let i = 0; i < inner.length; count++) {
    if (inner[i] !== '\\') {
      i += 1;
      continue;
    }
    const rest = inner.slice(i + 1);
    const m = /^(?:x[0-9a-fA-F]+|[0-7]{1,3}|.)/.exec(rest);
    i += 1 + (m?.[0].length ?? 1);
  }
  return count + 1;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

const ALIGNOF = new Map([['_Alignof', false], ['alignof', false], ['__alignof__', true], ['__alignof', true]]);

/**
 * An operand: an integer, an address (a pointer constant such as `(T *)0` or `&x.m`), or an
 * object at an address, which only `sizeof`, `&`, member access and indexing may use, since
 * reading it is not constant.
 */
type Operand<T> =
  | { kind: 'int'; value: number }
  | { kind: 'ptr'; pointee: T | undefined; address: number }
  | { kind: 'object'; type: T; address: number; spelled: string };

/**
 * Evaluate `tokens` as one integer constant expression. Throws ConstExprError with a message
 * naming the offending token when it is not one.
 */
export function evaluateConstExpr<T>(tokens: readonly Token[], ctx: ConstExprContext<T> = {}): number {
  let pos = 0;
  const peek = (k = 0) => tokens[pos + k];
  const isPunct = (v: string, k = 0) => peek(k)?.kind === 'punct' && peek(k)?.value === v;
  const fail = (msg: string): never => {
    throw new ConstExprError(msg);
  };
  const types = (what: string): TypeOracle<T> =>
    ctx.types ?? fail(`'${what}' needs types, which ${ctx.context ? `${ctx.context} does` : 'the preprocessor does'} not know`);
  const expect = (v: string, what: string) => {
    if (!isPunct(v)) fail(`expected '${v}' ${what}${peek() ? ` but found '${peek()!.value}'` : ''}`);
    pos += 1;
  };

  /** A type-name in parentheses at pos: `( type )`, consumed; undefined (nothing consumed) if not one. */
  const parenthesizedType = (): T | undefined => {
    if (!ctx.types || !isPunct('(')) return undefined;
    const parsed = ctx.types.typeName(tokens, pos + 1);
    if (!parsed || tokens[parsed.end]?.value !== ')') return undefined;
    pos = parsed.end + 1;
    return parsed.type;
  };

  const integer = (o: Operand<T>): number => {
    if (o.kind === 'int') return o.value;
    if (o.kind === 'ptr') return fail('an address is only an integer after a cast to an integer type');
    // An array decays to its address; any other object would be read, which is not constant.
    if (ctx.types?.isArray(o.type)) return fail('an address is only an integer after a cast to an integer type');
    return fail(`'${o.spelled}' reads an object, which a constant expression cannot`);
  };

  const decay = (o: Operand<T>): Operand<T> => {
    if (o.kind === 'object' && ctx.types?.isArray(o.type)) return { kind: 'ptr', pointee: ctx.types.element(o.type), address: o.address };
    return o;
  };

  /** `object.name`, or `pointer->name`. */
  const memberOf = (o: Operand<T>, name: string, arrow: boolean): Operand<T> => {
    const t = types(arrow ? '->' : '.');
    let base: { type: T; address: number; spelled: string };
    if (arrow) {
      const p = decay(o);
      if (p.kind !== 'ptr' || p.pointee === undefined) return fail(`'->${name}' needs a pointer to a struct or union`);
      base = { type: p.pointee, address: p.address, spelled: '' };
    } else {
      if (o.kind !== 'object') return fail(`'.${name}' needs a struct or union`);
      base = o;
    }
    const m = t.member(base.type, name);
    return { kind: 'object', type: m.type, address: base.address + m.offset, spelled: `${base.spelled}${arrow ? '->' : '.'}${name}` };
  };

  const indexOf = (o: Operand<T>, index: number): Operand<T> => {
    const t = types('[]');
    const p = decay(o);
    if (p.kind !== 'ptr' || p.pointee === undefined) return fail("'[]' needs an array or a pointer");
    return { kind: 'object', type: p.pointee, address: p.address + index * t.sizeOf(p.pointee), spelled: `[${index}]` };
  };

  const postfix = (o: Operand<T>): Operand<T> => {
    for (;;) {
      if (isPunct('.') || isPunct('->')) {
        const arrow = peek()!.value === '->';
        pos += 1;
        const name = peek();
        if (name?.kind !== 'id') fail(`expected a member name after '${arrow ? '->' : '.'}'`);
        pos += 1;
        o = memberOf(o, name!.value, arrow);
      } else if (isPunct('[')) {
        pos += 1;
        const index = conditional();
        expect(']', 'to close the subscript');
        o = indexOf(o, index);
      } else {
        return o;
      }
    }
  };

  /** `offsetof(type, member-designator)`: stddef.h's macro, which is built in like the header. */
  const offsetOf = (): number => {
    const t = types('offsetof');
    expect('(', "after 'offsetof'");
    const parsed = t.typeName(tokens, pos) ?? fail("expected a type as offsetof's first argument");
    pos = parsed.end;
    expect(',', "after offsetof's type");
    let o: Operand<T> = { kind: 'object', type: parsed.type, address: 0, spelled: t.describe(parsed.type) };
    const first = peek();
    if (first?.kind !== 'id') fail("expected a member name as offsetof's second argument");
    pos += 1;
    o = postfix(memberOf(o, first!.value, false));
    expect(')', 'to close offsetof');
    return o.kind === 'object' ? o.address : fail('offsetof needs a member');
  };

  const sizeOfOperand = (o: Operand<T>, t: TypeOracle<T>): number => {
    if (o.kind === 'object') return t.sizeOf(o.type);
    if (o.kind === 'ptr') return fail("'sizeof' of an address is not supported; write the pointer type");
    return fail("'sizeof' of an integer expression is not supported; write its type");
  };

  const primary = (): Operand<T> => {
    const t = peek();
    if (!t) return fail('unexpected end of expression');
    if (t.kind === 'num') {
      pos += 1;
      const v = parseIntegerLiteral(t.value);
      return { kind: 'int', value: v === undefined ? fail(`'${t.value}' is not an integer constant`) : v };
    }
    if (t.kind === 'char') {
      pos += 1;
      const v = charLiteralValue(t.value);
      return { kind: 'int', value: v === undefined ? fail(`unsupported character constant ${t.value}`) : v };
    }
    if (t.kind === 'id') {
      if (t.value === 'offsetof' || t.value === '__builtin_offsetof') {
        pos += 1;
        return { kind: 'int', value: offsetOf() };
      }
      pos += 1;
      const v = ctx.identifier?.(t.value);
      return { kind: 'int', value: v === undefined ? fail(`'${t.value}' is not a known constant`) : v };
    }
    if (t.value === '(') {
      pos += 1;
      const v = conditionalOperand();
      expect(')', 'to close the parenthesis');
      return v;
    }
    return fail(`unexpected '${t.value}'`);
  };

  const unary = (): Operand<T> => {
    const t = peek();
    if (t?.kind === 'id' && t.value === 'sizeof') {
      pos += 1;
      const oracle = types('sizeof');
      const type = parenthesizedType();
      if (type !== undefined) return { kind: 'int', value: oracle.sizeOf(type) };
      if (peek()?.kind === 'str') {
        pos += 1;
        return { kind: 'int', value: stringLiteralSize(peek(-1)!.value) ?? fail(`unsupported string literal ${peek(-1)!.value}`) };
      }
      return { kind: 'int', value: sizeOfOperand(unary(), oracle) };
    }
    if (t?.kind === 'id' && ALIGNOF.has(t.value)) {
      pos += 1;
      const oracle = types(t.value);
      const type = parenthesizedType() ?? fail(`'${t.value}' needs a type in parentheses`);
      return { kind: 'int', value: oracle.alignOf(type, ALIGNOF.get(t.value)!) };
    }
    if (t?.kind === 'punct') {
      if (t.value === '(') {
        const type = parenthesizedType();
        if (type !== undefined) {
          const oracle = ctx.types!;
          if (isPunct('{')) fail('a compound literal is not a constant');
          const operand = decay(unary());
          if (oracle.isPointer(type)) {
            if (operand.kind === 'object') return fail(`'${operand.spelled}' reads an object, which a constant expression cannot`);
            const address = operand.kind === 'int' ? operand.value : operand.address;
            return { kind: 'ptr', pointee: oracle.element(type), address };
          }
          const value = operand.kind === 'ptr' ? operand.address : integer(operand);
          return { kind: 'int', value: oracle.convert(type, value) };
        }
      }
      if (t.value === '&') {
        pos += 1;
        const operand = unary();
        if (operand.kind !== 'object') fail("'&' needs an object, such as ((T *)0)->member");
        const o = operand as Extract<Operand<T>, { kind: 'object' }>;
        return { kind: 'ptr', pointee: o.type, address: o.address };
      }
      if (t.value === '*') {
        pos += 1;
        const p = decay(unary());
        if (p.kind !== 'ptr' || p.pointee === undefined) fail("'*' needs a pointer");
        const q = p as Extract<Operand<T>, { kind: 'ptr' }>;
        return { kind: 'object', type: q.pointee!, address: q.address, spelled: '*' };
      }
      if (t.value === '-') { pos += 1; return { kind: 'int', value: -integer(unary()) }; }
      if (t.value === '+') { pos += 1; return { kind: 'int', value: integer(unary()) }; }
      if (t.value === '~') { pos += 1; return { kind: 'int', value: ~integer(unary()) }; }
      if (t.value === '!') { pos += 1; return { kind: 'int', value: integer(unary()) ? 0 : 1 }; }
    }
    return postfix(primary());
  };

  const binary = (minPrec: number): Operand<T> => {
    let leftOperand = unary();
    for (;;) {
      const t = peek();
      const prec = t?.kind === 'punct' ? BINARY_PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < minPrec) return leftOperand;
      pos += 1;
      let left = integer(leftOperand);
      const right = integer(binary(prec + 1));
      switch (t!.value) {
        case '||': left = left || right ? 1 : 0; break;
        case '&&': left = left && right ? 1 : 0; break;
        case '|': left |= right; break;
        case '^': left ^= right; break;
        case '&': left &= right; break;
        case '==': left = left === right ? 1 : 0; break;
        case '!=': left = left !== right ? 1 : 0; break;
        case '<': left = left < right ? 1 : 0; break;
        case '>': left = left > right ? 1 : 0; break;
        case '<=': left = left <= right ? 1 : 0; break;
        case '>=': left = left >= right ? 1 : 0; break;
        case '<<': left = left * 2 ** right; break;
        case '>>': left = Math.floor(left / 2 ** right); break;
        case '+': left += right; break;
        case '-': left -= right; break;
        case '*': left *= right; break;
        case '/': if (right === 0) fail('division by zero'); left = Math.trunc(left / right); break;
        case '%': if (right === 0) fail('division by zero'); left %= right; break;
      }
      leftOperand = { kind: 'int', value: left };
    }
  };

  const conditionalOperand = (): Operand<T> => {
    const cond = binary(1);
    if (!isPunct('?')) return cond;
    pos += 1;
    const whenTrue = conditionalOperand();
    expect(':', 'in the conditional expression');
    const whenFalse = conditionalOperand();
    return integer(cond) ? whenTrue : whenFalse;
  };

  const conditional = (): number => integer(conditionalOperand());

  if (tokens.length === 0) fail('empty expression');
  const value = conditional();
  if (pos < tokens.length) fail(`unexpected '${tokens[pos].value}'`);
  return value;
}
