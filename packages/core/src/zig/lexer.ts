/**
 * Zig lexer for the declaration-level subset the layout parser needs: identifiers (also
 * @"quoted"), builtins, number, character and string literals (also `\\` multiline strings), and
 * Zig's operators. Comments, doc comments included, are dropped.
 */
export type ZigTokenKind = 'ident' | 'builtin' | 'int' | 'float' | 'char' | 'string' | 'punct' | 'eof';

export interface ZigToken {
  kind: ZigTokenKind;
  text: string;
  /** Integer and character literals. */
  value?: bigint;
  line: number;
  /** Offsets into the source: [start, end). */
  start: number;
  end: number;
}

export class ZigLexError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(message);
  }
}

// Longest first.
const PUNCTUATORS = [
  '<<|=', '<<=', '>>=', '+%=', '-%=', '*%=', '+|=', '-|=', '*|=', '...', '<<|',
  '**', '++', '+%', '-%', '*%', '+|', '-|', '*|', '<<', '>>', '==', '!=', '<=', '>=', '=>', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '||', '..', '.*', '.?',
  '{', '}', '(', ')', '[', ']', ';', ',', ':', '!', '=', '<', '>', '+', '-', '*', '/', '%', '^', '&', '|', '~', '?', '.',
];

const isIdentStart = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c);
const isIdentPart = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

function parseInteger(text: string, line: number): bigint {
  const clean = text.replace(/_/g, '');
  try {
    if (/^0[oO]/.test(clean)) return BigInt('0o' + clean.slice(2));
    return BigInt(clean);
  } catch {
    throw new ZigLexError(`Invalid number '${text}'.`, line);
  }
}

/** One escape sequence at text[i] (after the backslash): its code point and length. */
function escape(text: string, i: number, line: number): { code: number; length: number } {
  const c = text[i];
  switch (c) {
    case 'n':
      return { code: 10, length: 1 };
    case 'r':
      return { code: 13, length: 1 };
    case 't':
      return { code: 9, length: 1 };
    case '\\':
    case "'":
    case '"':
      return { code: c.charCodeAt(0), length: 1 };
    case 'x': {
      const hex = text.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new ZigLexError('Invalid \\x escape.', line);
      return { code: parseInt(hex, 16), length: 3 };
    }
    case 'u': {
      const m = /^\{([0-9a-fA-F]+)\}/.exec(text.slice(i + 1));
      if (!m) throw new ZigLexError('Invalid \\u escape.', line);
      return { code: parseInt(m[1]!, 16), length: 1 + m[0].length };
    }
    default:
      throw new ZigLexError(`Invalid escape '\\${c ?? ''}'.`, line);
  }
}

export function lexZig(text: string): ZigToken[] {
  const tokens: ZigToken[] = [];
  let i = 0;
  let line = 1;
  const push = (kind: ZigTokenKind, start: number, end: number, extra: Partial<ZigToken> = {}) => {
    tokens.push({ kind, text: text.slice(start, end), line, start, end, ...extra });
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
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    const start = i;

    // Multiline string literal: consecutive lines starting with \\.
    if (c === '\\' && text[i + 1] === '\\') {
      const lines: string[] = [];
      const startLine = line;
      for (;;) {
        let j = i + 2;
        while (j < text.length && text[j] !== '\n') j += 1;
        lines.push(text.slice(i + 2, j));
        i = j;
        // Another line of the same literal?
        let k = i + 1;
        while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\r')) k += 1;
        if (i < text.length && text[k] === '\\' && text[k + 1] === '\\') {
          line += 1;
          i = k;
          continue;
        }
        break;
      }
      tokens.push({ kind: 'string', text: lines.join('\n'), line: startLine, start, end: i });
      continue;
    }

    if (c === '@') {
      if (text[i + 1] === '"') {
        // @"quoted identifier"
        let j = i + 2;
        let name = '';
        while (j < text.length && text[j] !== '"') {
          if (text[j] === '\n') throw new ZigLexError('Unterminated identifier.', line);
          if (text[j] === '\\') {
            const e = escape(text, j + 1, line);
            name += String.fromCodePoint(e.code);
            j += 1 + e.length;
          } else {
            name += text[j];
            j += 1;
          }
        }
        if (j >= text.length) throw new ZigLexError('Unterminated identifier.', line);
        i = j + 1;
        tokens.push({ kind: 'ident', text: name, line, start, end: i });
        continue;
      }
      if (isIdentStart(text[i + 1])) {
        let j = i + 1;
        while (isIdentPart(text[j])) j += 1;
        i = j;
        push('builtin', start, i);
        continue;
      }
      throw new ZigLexError("Unexpected '@'.", line);
    }

    if (isIdentStart(c)) {
      let j = i;
      while (isIdentPart(text[j])) j += 1;
      i = j;
      push('ident', start, i);
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i;
      const radix = c === '0' ? text[i + 1] : undefined;
      if (radix === 'x' || radix === 'X' || radix === 'o' || radix === 'O' || radix === 'b' || radix === 'B') {
        j += 2;
        const digit = radix === 'x' || radix === 'X' ? /[0-9a-fA-F_]/ : radix === 'o' || radix === 'O' ? /[0-7_]/ : /[01_]/;
        while (j < text.length && digit.test(text[j]!)) j += 1;
        let isFloat = false;
        if ((radix === 'x' || radix === 'X') && text[j] === '.' && /[0-9a-fA-F]/.test(text[j + 1] ?? '')) {
          isFloat = true;
          j += 1;
          while (j < text.length && /[0-9a-fA-F_]/.test(text[j]!)) j += 1;
        }
        if ((radix === 'x' || radix === 'X') && (text[j] === 'p' || text[j] === 'P')) {
          isFloat = true;
          j += 1;
          if (text[j] === '+' || text[j] === '-') j += 1;
          while (j < text.length && /[0-9_]/.test(text[j]!)) j += 1;
        }
        i = j;
        if (isFloat) push('float', start, i);
        else push('int', start, i, { value: parseInteger(text.slice(start, i), line) });
        continue;
      }
      while (j < text.length && /[0-9_]/.test(text[j]!)) j += 1;
      let isFloat = false;
      if (text[j] === '.' && /[0-9]/.test(text[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < text.length && /[0-9_]/.test(text[j]!)) j += 1;
      }
      if (text[j] === 'e' || text[j] === 'E') {
        isFloat = true;
        j += 1;
        if (text[j] === '+' || text[j] === '-') j += 1;
        while (j < text.length && /[0-9_]/.test(text[j]!)) j += 1;
      }
      i = j;
      if (isFloat) push('float', start, i);
      else push('int', start, i, { value: parseInteger(text.slice(start, i), line) });
      continue;
    }

    if (c === "'") {
      let j = i + 1;
      let code: number;
      if (text[j] === '\\') {
        const e = escape(text, j + 1, line);
        code = e.code;
        j += 1 + e.length;
      } else {
        const cp = text.codePointAt(j);
        if (cp === undefined || text[j] === '\n') throw new ZigLexError('Unterminated character literal.', line);
        code = cp;
        j += cp > 0xffff ? 2 : 1;
      }
      if (text[j] !== "'") throw new ZigLexError('Unterminated character literal.', line);
      i = j + 1;
      push('char', start, i, { value: BigInt(code) });
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\n') throw new ZigLexError('Unterminated string literal.', line);
        if (text[j] === '\\') {
          const e = escape(text, j + 1, line);
          value += String.fromCodePoint(e.code);
          j += 1 + e.length;
        } else {
          value += text[j];
          j += 1;
        }
      }
      if (j >= text.length) throw new ZigLexError('Unterminated string literal.', line);
      i = j + 1;
      tokens.push({ kind: 'string', text: value, line, start, end: i });
      continue;
    }

    const p = PUNCTUATORS.find((op) => text.startsWith(op, i));
    if (!p) throw new ZigLexError(`Unexpected character '${c}'.`, line);
    i += p.length;
    push('punct', start, i);
  }
  tokens.push({ kind: 'eof', text: '', line, start: text.length, end: text.length });
  return tokens;
}
