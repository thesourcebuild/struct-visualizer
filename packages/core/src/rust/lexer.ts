/**
 * Rust lexer for the item-level subset the layout parser needs. Produces the shared Token shape,
 * so constant expressions go through the same evaluator as C and Go.
 *
 * Handles what differs from C: nested block comments, lifetimes ('a) versus char literals,
 * raw strings (r#"..."#), byte strings, raw identifiers (r#type) and literal suffixes (4usize).
 */
import type { Token } from '../parser/tokens';

export class RustLexError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(message);
  }
}

// Longest first. '>>' and '<<' are split back into single angle brackets by the type parser.
const PUNCTUATORS = [
  '..=', '...', '<<=', '>>=', '::', '->', '=>', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=', '..',
  '{', '}', '(', ')', '[', ']', ';', ',', ':', '#', '!', '=', '<', '>', '+', '-', '*', '/', '%',
  '^', '&', '|', '~', '?', '.', '@', '$',
];

const isIdentStart = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c);
const isIdentPart = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

/** Integer and float suffixes: the type of the literal, not part of its value. */
const NUMBER_SUFFIX = /(?:u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64)$/;

export interface RustToken extends Token {
  /** For a number with a type suffix (4u8): the suffix. */
  suffix?: string;
  /** Lifetimes ('a) are kept as tokens of their own so generics can skip them. */
  lifetime?: boolean;
}

export function lexRust(text: string): RustToken[] {
  const tokens: RustToken[] = [];
  let i = 0;
  let line = 1;

  const advance = (to: number) => {
    for (let k = i; k < to && k < text.length; k++) if (text[k] === '\n') line += 1;
    i = to;
  };

  while (i < text.length) {
    const c = text[i]!;

    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }

    // Comments: line, and nested block comments.
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const startLine = line;
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else {
          j += 1;
        }
      }
      if (depth !== 0) throw new RustLexError('Unterminated block comment.', startLine);
      advance(j);
      continue;
    }

    // Raw strings r"..", r#".."#, br#".."#, and raw identifiers r#name.
    const raw = /^(b?r)(#*)"/.exec(text.slice(i, i + 260));
    if (raw) {
      const hashes = raw[2]!;
      const close = `"${hashes}`;
      const end = text.indexOf(close, i + raw[0].length);
      if (end === -1) throw new RustLexError('Unterminated raw string.', line);
      const start = line;
      const value = text.slice(i, end + close.length);
      advance(end + close.length);
      tokens.push({ kind: 'str', value, line: start });
      continue;
    }
    if (c === 'r' && text[i + 1] === '#' && isIdentStart(text[i + 2])) {
      let j = i + 2;
      while (isIdentPart(text[j])) j += 1;
      tokens.push({ kind: 'id', value: text.slice(i + 2, j), line });
      i = j;
      continue;
    }

    // Strings and byte strings.
    if (c === '"' || (c === 'b' && text[i + 1] === '"')) {
      let j = c === 'b' ? i + 2 : i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) throw new RustLexError('Unterminated string literal.', line);
      const start = line;
      const value = text.slice(i, j + 1);
      advance(j + 1);
      tokens.push({ kind: 'str', value, line: start });
      continue;
    }

    // Char and byte literals versus lifetimes: 'a' and '\n' are chars, 'a (no closing quote
    // right after one character) is a lifetime.
    if (c === '\'' || (c === 'b' && text[i + 1] === '\'')) {
      const q = c === 'b' ? i + 1 : i;
      if (text[q + 1] === '\\') {
        let j = q + 2;
        while (j < text.length && text[j] !== '\'') j += 1;
        tokens.push({ kind: 'char', value: text.slice(q, j + 1), line });
        i = j + 1;
        continue;
      }
      // A char is one code point followed by a quote.
      const cp = text.codePointAt(q + 1);
      const width = cp !== undefined && cp > 0xffff ? 2 : 1;
      if (text[q + 1 + width] === '\'') {
        tokens.push({ kind: 'char', value: text.slice(q, q + 2 + width), line });
        i = q + 2 + width;
        continue;
      }
      if (c === '\'' && isIdentStart(text[i + 1])) {
        let j = i + 1;
        while (isIdentPart(text[j])) j += 1;
        tokens.push({ kind: 'id', value: text.slice(i, j), line, lifetime: true });
        i = j;
        continue;
      }
      throw new RustLexError(`Unexpected quote.`, line);
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (isIdentPart(text[j])) j += 1;
      tokens.push({ kind: 'id', value: text.slice(i, j), line });
      i = j;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i;
      if (c === '0' && /[xob]/.test(text[i + 1] ?? '')) {
        j = i + 2;
        while (/[0-9A-Fa-f_]/.test(text[j] ?? '')) j += 1;
      } else {
        while (/[0-9_]/.test(text[j] ?? '')) j += 1;
        // A fraction, but not a range (1..2) or a method call (1.max(2)).
        if (text[j] === '.' && /[0-9]/.test(text[j + 1] ?? '')) {
          j += 1;
          while (/[0-9_]/.test(text[j] ?? '')) j += 1;
        }
        if (/[eE]/.test(text[j] ?? '') && /[0-9+-]/.test(text[j + 1] ?? '')) {
          j += 2;
          while (/[0-9_]/.test(text[j] ?? '')) j += 1;
        }
      }
      while (isIdentPart(text[j])) j += 1; // suffix
      let value = text.slice(i, j);
      let suffix: string | undefined;
      const hex = /^0x/i.test(value);
      const m = NUMBER_SUFFIX.exec(value);
      // In hex, a trailing f32/f64 is digits, not a suffix.
      if (m && !(hex && m[0].startsWith('f'))) {
        suffix = m[0];
        value = value.slice(0, -m[0].length).replace(/_$/, '');
      }
      tokens.push({ kind: 'num', value: value.replace(/^0o/i, '0o'), line, suffix });
      i = j;
      continue;
    }

    const p = PUNCTUATORS.find((op) => text.startsWith(op, i));
    if (!p) throw new RustLexError(`Unexpected character '${c}'.`, line);
    tokens.push({ kind: 'punct', value: p, line });
    i += p.length;
  }

  return tokens;
}
