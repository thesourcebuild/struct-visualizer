/**
 * Integer constant-expression evaluator (C11 6.6), used for array sizes, bit-field widths,
 * alignment arguments, enum values and #if conditions.
 *
 * Operates on tokens after macro expansion. Identifiers are resolved through `lookup` (enum
 * constants); unknown identifiers are an error, except in #if where C says they evaluate to 0 --
 * the preprocessor passes a lookup that does exactly that.
 */
import type { Token } from './tokens';

export class ConstExprError extends Error {}

export type IdentifierLookup = (name: string) => number | undefined;

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

function charLiteralValue(text: string): number | undefined {
  const inner = text.slice(1, -1);
  if (inner.length === 1) return inner.charCodeAt(0);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11 };
  if (inner.length === 2 && inner[0] === '\\' && inner[1] in escapes) return escapes[inner[1]];
  return undefined;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

/**
 * Evaluate `tokens` as one integer constant expression. Throws ConstExprError with a message
 * naming the offending token when it is not one.
 */
export function evaluateConstExpr(tokens: readonly Token[], lookup: IdentifierLookup): number {
  let pos = 0;
  const peek = () => tokens[pos];
  const fail = (msg: string): never => {
    throw new ConstExprError(msg);
  };

  const primary = (): number => {
    const t = peek();
    if (!t) return fail('unexpected end of expression');
    pos += 1;
    if (t.kind === 'num') {
      const v = parseIntegerLiteral(t.value);
      return v === undefined ? fail(`'${t.value}' is not an integer constant`) : v;
    }
    if (t.kind === 'char') {
      const v = charLiteralValue(t.value);
      return v === undefined ? fail(`unsupported character constant ${t.value}`) : v;
    }
    if (t.kind === 'id') {
      if (t.value === 'sizeof' || t.value === '_Alignof' || t.value === 'alignof') {
        return fail(`'${t.value}' depends on the target and cannot be used here`);
      }
      const v = lookup(t.value);
      return v === undefined ? fail(`'${t.value}' is not a known constant`) : v;
    }
    if (t.value === '(') {
      const v = conditional();
      if (peek()?.value !== ')') fail("missing ')'");
      pos += 1;
      return v;
    }
    return fail(`unexpected '${t.value}'`);
  };

  const unary = (): number => {
    const t = peek();
    if (t?.kind === 'punct') {
      if (t.value === '-') { pos += 1; return -unary(); }
      if (t.value === '+') { pos += 1; return unary(); }
      if (t.value === '~') { pos += 1; return ~unary(); }
      if (t.value === '!') { pos += 1; return unary() ? 0 : 1; }
    }
    return primary();
  };

  const binary = (minPrec: number): number => {
    let left = unary();
    for (;;) {
      const t = peek();
      const prec = t?.kind === 'punct' ? BINARY_PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      pos += 1;
      const right = binary(prec + 1);
      switch (t.value) {
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
    }
  };

  const conditional = (): number => {
    const cond = binary(1);
    if (peek()?.value !== '?') return cond;
    pos += 1;
    const whenTrue = conditional();
    if (peek()?.value !== ':') fail("missing ':' in conditional expression");
    pos += 1;
    const whenFalse = conditional();
    return cond ? whenTrue : whenFalse;
  };

  if (tokens.length === 0) fail('empty expression');
  const value = conditional();
  if (pos < tokens.length) fail(`unexpected '${tokens[pos].value}'`);
  return value;
}
