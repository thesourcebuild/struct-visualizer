/**
 * Go's lexical grammar (spec: "Lexical elements"): comments, identifiers, keywords, operators,
 * integer, floating-point, imaginary, rune and string literals, and automatic semicolon
 * insertion. Literals keep their source text; decodeGoString / decodeGoRune give their values.
 */
import type { ParseError } from '../types';

export type GoTokenKind = 'id' | 'int' | 'float' | 'imag' | 'char' | 'str' | 'punct';

export interface GoToken {
  kind: GoTokenKind;
  /** Source text; for a semicolon inserted at a line end, ';'. */
  value: string;
  /** 1-based line of the token's first character. */
  line: number;
  /** A semicolon the lexer inserted at the end of a line (or of the input). */
  inserted?: boolean;
}

export const GO_KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for',
  'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select',
  'struct', 'switch', 'type', 'var',
]);

// Longest first, so '&^=' wins over '&^' and '&'.
const OPERATORS = [
  '&^=', '<<=', '>>=', '...',
  '&&', '||', '<-', '++', '--', '==', '!=', '<=', '>=', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '&^',
  '+', '-', '*', '/', '%', '&', '|', '^', '<', '>', '=', '!', '~', '(', ')', '[', ']', '{', '}', ',', ';', '.', ':',
];

const isLetter = (c: string) => /[\p{L}_]/u.test(c);
const isLetterOrDigit = (c: string) => /[\p{L}\p{Nd}_]/u.test(c);
const isDecimal = (c: string | undefined) => !!c && c >= '0' && c <= '9';

// Spec: "Integer literals", "Floating-point literals", "Imaginary literals".
const DEC_DIGITS = '[0-9](?:_?[0-9])*';
const HEX_DIGITS = '[0-9a-fA-F](?:_?[0-9a-fA-F])*';
const INT = `(?:0|[1-9](?:_?[0-9])*|0[bB]_?[01](?:_?[01])*|0[oO]?_?[0-7](?:_?[0-7])*|0[xX]_?${HEX_DIGITS})`;
const DEC_EXP = `[eE][+-]?${DEC_DIGITS}`;
const DEC_FLOAT = `(?:${DEC_DIGITS}\\.(?:${DEC_DIGITS})?(?:${DEC_EXP})?|${DEC_DIGITS}${DEC_EXP}|\\.${DEC_DIGITS}(?:${DEC_EXP})?)`;
const HEX_FLOAT = `0[xX](?:_?${HEX_DIGITS}\\.(?:${HEX_DIGITS})?|_?${HEX_DIGITS}|\\.${HEX_DIGITS})[pP][+-]?${DEC_DIGITS}`;
const INT_RE = new RegExp(`^${INT}$`);
const FLOAT_RE = new RegExp(`^(?:${DEC_FLOAT}|${HEX_FLOAT})$`);
const IMAG_RE = new RegExp(`^(?:${DEC_DIGITS}|${INT}|${DEC_FLOAT}|${HEX_FLOAT})i$`);

/** The kind of a numeric literal, or undefined when the text is not one. */
export function numberKind(text: string): 'int' | 'float' | 'imag' | undefined {
  if (INT_RE.test(text)) return 'int';
  if (FLOAT_RE.test(text)) return 'float';
  if (IMAG_RE.test(text)) return 'imag';
  return undefined;
}

export interface GoLexResult {
  tokens: GoToken[];
  errors: ParseError[];
}

export function lexGo(text: string): GoLexResult {
  const tokens: GoToken[] = [];
  const errors: ParseError[] = [];
  let i = 0;
  let line = 1;
  const error = (message: string, at = line) => errors.push({ message, line: at, type: 'syntax' });

  // Spec: "When the input is broken into tokens, a semicolon is automatically inserted into the
  // token stream immediately after a line's final token if that token is an identifier, a
  // literal, one of the keywords break, continue, fallthrough, return, or one of ++ -- ) ] }".
  const lineEnd = () => {
    const last = tokens[tokens.length - 1];
    if (!last || (last.kind === 'punct' && last.value === ';')) return;
    const qualifies =
      (last.kind === 'id' && (!GO_KEYWORDS.has(last.value) || ['break', 'continue', 'fallthrough', 'return'].includes(last.value))) ||
      last.kind === 'int' || last.kind === 'float' || last.kind === 'imag' || last.kind === 'char' || last.kind === 'str' ||
      (last.kind === 'punct' && ['++', '--', ')', ']', '}'].includes(last.value));
    if (qualifies) tokens.push({ kind: 'punct', value: ';', line: last.line, inserted: true });
  };

  while (i < text.length) {
    const c = text[i];
    if (c === '\n') {
      lineEnd();
      line += 1;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
      continue;
    }

    if (c === '/' && text[i + 1] === '/') {
      // A line comment acts like a newline: the newline that ends it does the work.
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = line;
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        error('Comment not terminated.', start);
        break;
      }
      const body = text.slice(i + 2, end);
      const newlines = body.split('\n').length - 1;
      // A general comment containing newlines acts like a newline, otherwise like a space.
      if (newlines > 0) lineEnd();
      line += newlines;
      i = end + 2;
      continue;
    }

    if (isLetter(c)) {
      let j = i + 1;
      while (j < text.length && isLetterOrDigit(text[j])) j += 1;
      tokens.push({ kind: 'id', value: text.slice(i, j), line });
      i = j;
      continue;
    }

    if (isDecimal(c) || (c === '.' && isDecimal(text[i + 1]))) {
      // The longest sequence that can belong to a number, then checked against the grammar.
      const hex = c === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X');
      let j = i;
      let dot = false;
      while (j < text.length) {
        const d = text[j];
        if (/[0-9A-Za-z_]/.test(d)) {
          j += 1;
        } else if (d === '.' && !dot) {
          dot = true;
          j += 1;
        } else if ((d === '+' || d === '-') && (hex ? /[pP]/ : /[eE]/).test(text[j - 1])) {
          j += 1;
        } else {
          break;
        }
      }
      const value = text.slice(i, j);
      const kind = numberKind(value);
      if (!kind) error(`Invalid number literal '${value}'.`);
      tokens.push({ kind: kind ?? 'int', value, line });
      i = j;
      continue;
    }

    if (c === '`') {
      const start = line;
      const end = text.indexOf('`', i + 1);
      if (end === -1) {
        error('Raw string literal not terminated.', start);
        break;
      }
      const value = text.slice(i, end + 1);
      tokens.push({ kind: 'str', value, line: start });
      line += value.split('\n').length - 1;
      i = end + 1;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length || text[j] !== c) {
        error(c === '"' ? 'String literal not terminated.' : 'Rune literal not terminated.');
        tokens.push({ kind: c === '"' ? 'str' : 'char', value: text.slice(i, j), line });
        i = j;
        continue;
      }
      const value = text.slice(i, j + 1);
      try {
        if (c === '"') decodeGoString(value);
        else decodeGoRune(value);
      } catch (err) {
        if (!(err instanceof GoLiteralError)) throw err;
        error(err.message);
      }
      tokens.push({ kind: c === '"' ? 'str' : 'char', value, line });
      i = j + 1;
      continue;
    }

    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) {
      tokens.push({ kind: 'punct', value: op, line });
      i += op.length;
      continue;
    }

    error(`Invalid character '${c}'.`);
    i += 1;
  }
  lineEnd();
  return { tokens, errors };
}

export class GoLiteralError extends Error {}

/** One escape sequence or character at `text[i]`; `quote` is the literal's delimiter. */
function decodeChar(text: string, i: number, quote: string): { code: number; byte: boolean; next: number } {
  const c = text[i];
  if (c !== '\\') {
    const code = text.codePointAt(i)!;
    return { code, byte: false, next: i + (code > 0xffff ? 2 : 1) };
  }
  const e = text[i + 1];
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 };
  if (e in simple) return { code: simple[e], byte: false, next: i + 2 };
  if (e === quote) return { code: quote.charCodeAt(0), byte: false, next: i + 2 };
  const digits = (n: number, re: RegExp, base: number) => {
    const s = text.slice(i + 2, i + 2 + n);
    if (s.length !== n || !re.test(s)) throw new GoLiteralError(`Invalid escape sequence in ${text}.`);
    return parseInt(s, base);
  };
  if (e >= '0' && e <= '7') {
    const s = text.slice(i + 1, i + 4);
    if (!/^[0-7]{3}$/.test(s)) throw new GoLiteralError(`Invalid escape sequence in ${text}.`);
    const code = parseInt(s, 8);
    if (code > 255) throw new GoLiteralError(`Octal escape value ${code} > 255 in ${text}.`);
    return { code, byte: true, next: i + 4 };
  }
  if (e === 'x') return { code: digits(2, /^[0-9a-fA-F]{2}$/, 16), byte: true, next: i + 4 };
  if (e === 'u' || e === 'U') {
    const n = e === 'u' ? 4 : 8;
    const code = digits(n, /^[0-9a-fA-F]+$/, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code < 0xe000)) throw new GoLiteralError(`Escape sequence is an invalid Unicode code point in ${text}.`);
    return { code, byte: false, next: i + 2 + n };
  }
  throw new GoLiteralError(`Unknown escape sequence in ${text}.`);
}

/** The UTF-8 encoding of a code point. */
export function utf8(code: number): number[] {
  if (code < 0x80) return [code];
  if (code < 0x800) return [0xc0 | (code >> 6), 0x80 | (code & 63)];
  if (code < 0x10000) return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)];
  return [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)];
}

/** The bytes of a string literal (raw or interpreted), as Go stores them (UTF-8). */
export function decodeGoString(literal: string): number[] {
  if (literal.startsWith('`')) {
    // Spec: "Carriage return characters ('\r') inside raw string literals are discarded".
    const body = literal.slice(1, -1).replace(/\r/g, '');
    return [...body].flatMap((ch) => utf8(ch.codePointAt(0)!));
  }
  const bytes: number[] = [];
  let i = 1;
  while (i < literal.length - 1) {
    const { code, byte, next } = decodeChar(literal, i, '"');
    if (byte) bytes.push(code);
    else bytes.push(...utf8(code));
    i = next;
  }
  return bytes;
}

/** The code point of a rune literal. */
export function decodeGoRune(literal: string): number {
  if (literal.length < 3) throw new GoLiteralError('Empty rune literal or unescaped \' in rune literal.');
  const { code, next } = decodeChar(literal, 1, "'");
  if (next !== literal.length - 1) throw new GoLiteralError(`More than one character in rune literal ${literal}.`);
  return code;
}

/** Index of the token matching the opener at `start` ('(', '[' or '{'), or -1. */
export function findClosing(tokens: readonly GoToken[], start: number): number {
  const open = tokens[start].value;
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].kind !== 'punct') continue;
    if (tokens[i].value === open) depth += 1;
    else if (tokens[i].value === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
