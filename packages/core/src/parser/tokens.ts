/**
 * C tokenizer for declarations. Runs on preprocessed text (comments and directives already
 * removed), so it only has to know identifiers, numbers, literals and punctuators.
 */

export type TokenKind = 'id' | 'num' | 'str' | 'char' | 'punct';

export interface Token {
  kind: TokenKind;
  value: string;
  /** 1-based source line, for error messages. */
  line: number;
}

// Longest first, so '<<=' wins over '<<' and '<'.
const PUNCTUATORS = [
  '...', '<<=', '>>=', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::', '##',
  '{', '}', '(', ')', '[', ']', ';', ',', ':', '*', '&', '=', '<', '>', '+', '-', '/', '%',
  '~', '!', '^', '|', '?', '.', '#',
];

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;

  while (i < text.length) {
    const c = text[i];

    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j])) j += 1;
      tokens.push({ kind: 'id', value: text.slice(i, j), line });
      i = j;
      continue;
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      // pp-number: digits, letters (hex digits, suffixes), dots, and exponent signs.
      let j = i + 1;
      while (j < text.length) {
        const d = text[j];
        if (isIdentPart(d) || d === '.') {
          j += 1;
        } else if ((d === '+' || d === '-') && /[eEpP]/.test(text[j - 1])) {
          j += 1;
        } else {
          break;
        }
      }
      tokens.push({ kind: 'num', value: text.slice(i, j), line });
      i = j;
      continue;
    }

    if (c === '`') {
      // Go raw string literal (struct tags); may span lines. Never valid C.
      let j = i + 1;
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\n') line += 1;
        j += 1;
      }
      tokens.push({ kind: 'str', value: text.slice(i, j + 1), line });
      i = j + 1;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') {
        j += text[j] === '\\' ? 2 : 1;
      }
      tokens.push({ kind: c === '"' ? 'str' : 'char', value: text.slice(i, j + 1), line });
      i = j + 1;
      continue;
    }

    const punct = PUNCTUATORS.find((p) => text.startsWith(p, i));
    if (punct) {
      tokens.push({ kind: 'punct', value: punct, line });
      i += punct.length;
      continue;
    }

    // Anything else (stray characters such as '@' or '$') is kept as a punctuator so the
    // parser can report it with its line instead of silently dropping it.
    tokens.push({ kind: 'punct', value: c, line });
    i += 1;
  }

  return tokens;
}

/** Index of the token matching the opener at `start` (which must be '(', '[' or '{'). */
export function findClosing(tokens: readonly Token[], start: number): number {
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
