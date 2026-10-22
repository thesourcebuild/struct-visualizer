import type { DataModel, OSType } from './abi/data-models';

/**
 * How a packed layout is asked for in source. The three are not interchangeable: compilers accept
 * different ones, and GCC and MSVC lay out zero-width bit-fields differently under `packed` than
 * under `#pragma pack(1)` (checked in tests/cross-compiler.test.ts).
 */
export type PackingSyntax = 'pragma' | 'attribute' | 'keyword';

export interface PackingSyntaxInfo {
  id: PackingSyntax;
  /** The source written for it. */
  code: string;
  /** Compilers that accept it, for the option's label. */
  compilers: string;
}

export const packingSyntaxes: Record<PackingSyntax, PackingSyntaxInfo> = {
  pragma: { id: 'pragma', code: '#pragma pack(push, 1)', compilers: 'MSVC, GCC, Clang, Keil, IAR' },
  attribute: { id: 'attribute', code: '__attribute__((packed))', compilers: 'GCC, Clang, Keil armclang, XC16, XC32' },
  keyword: { id: 'keyword', code: '__packed', compilers: 'Keil, IAR' },
};

/**
 * The syntaxes the platform's compiler accepts:
 * - Windows: the model is MSVC, which has only `#pragma pack`.
 * - SDCC and Keil C51 (8051): only `#pragma pack`. SDCC rejects the GCC attribute and `__packed`
 *   (tests/cross-compiler.test.ts); C51 could not be run, but on the 8051 every type is already
 *   1-byte aligned, so packing changes nothing, and C requires an unrecognised pragma to be
 *   ignored (C11 6.10.6), which makes the pragma the one form safe for both.
 * - Everywhere else the compiler may be GCC or Clang, or Keil or IAR for the same target, so all
 *   three are offered.
 */
export function packingSyntaxesFor(os: OSType, dataModel: DataModel): PackingSyntax[] {
  if (os === 'windows' || dataModel === 'SDCC' || dataModel === 'C51') return ['pragma'];
  return ['attribute', 'pragma', 'keyword'];
}

/** `requested` when the platform's compiler accepts it, otherwise that compiler's first syntax. */
export function resolvePackingSyntax(os: OSType, dataModel: DataModel, requested?: string): PackingSyntax {
  const allowed = packingSyntaxesFor(os, dataModel);
  return allowed.find((s) => s === requested) ?? allowed[0]!;
}

const ATTRIBUTE_WORDS = new Set(['__attribute__', '__attribute', '__declspec', 'alignas', '_Alignas', '__packed']);
const RECORD_WORDS = new Set(['struct', 'union', 'class']);
const isIdentStart = (c: string | undefined) => c !== undefined && /[A-Za-z_]/.test(c);
const isIdentPart = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);

/** Index after whitespace and comments from `i`. */
function skipSpace(code: string, i: number): number {
  for (;;) {
    while (i < code.length && /\s/.test(code[i]!)) i += 1;
    if (code.startsWith('//', i)) {
      const end = code.indexOf('\n', i);
      i = end < 0 ? code.length : end;
    } else if (code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
    } else {
      return i;
    }
  }
}

/** Index after the bracketed group opening at `i` (`(` or `[`), or -1 if it never closes. */
function skipGroup(code: string, i: number): number {
  const open = code[i]!;
  const close = open === '(' ? ')' : ']';
  let depth = 0;
  for (let j = i; j < code.length; j += 1) {
    if (code[j] === open) depth += 1;
    else if (code[j] === close && --depth === 0) return j + 1;
  }
  return -1;
}

/**
 * Whether the record keyword ending at `i` opens a definition: optional attributes, an optional
 * (possibly qualified) tag, more attributes or `final`, then `{`. A forward declaration, a
 * reference such as `struct S *p` or `sizeof(struct S)` is left alone.
 */
function opensDefinition(code: string, i: number): boolean {
  let j = skipSpace(code, i);
  const skipAttributes = () => {
    for (;;) {
      j = skipSpace(code, j);
      if (code.startsWith('[[', j)) {
        const end = code.indexOf(']]', j);
        if (end < 0) return;
        j = end + 2;
        continue;
      }
      if (!isIdentStart(code[j])) return;
      let k = j;
      while (isIdentPart(code[k])) k += 1;
      const word = code.slice(j, k);
      if (!ATTRIBUTE_WORDS.has(word) && word !== 'final') return;
      j = skipSpace(code, k);
      if (word !== '__packed' && word !== 'final' && code[j] === '(') {
        const end = skipGroup(code, j);
        if (end < 0) return;
        j = end;
      }
    }
  };
  skipAttributes();
  if (isIdentStart(code[j])) {
    while (isIdentPart(code[j])) j += 1;
    for (;;) {
      j = skipSpace(code, j);
      if (!code.startsWith('::', j)) break;
      j = skipSpace(code, j + 2);
      while (isIdentPart(code[j])) j += 1;
    }
    skipAttributes();
  }
  return code[skipSpace(code, j)] === '{';
}

/**
 * The source with every struct, union and class definition packed in the given syntax: wrapped in
 * `#pragma pack(push, 1)`, or with `__attribute__((packed))` after each definition's keyword, or
 * `__packed` before it. Nested and anonymous definitions are included; comments, string literals
 * and preprocessor lines are left as they are. The Struct Layout tool lays out the result and the
 * Verification Code tool prints it, so the two always describe the same source.
 */
export function applyPacking(code: string, syntax: PackingSyntax): string {
  if (syntax === 'pragma') return `#pragma pack(push, 1)\n${code}\n#pragma pack(pop)\n`;

  const inserts: { at: number; text: string }[] = [];
  let i = 0;
  let lineStart = true;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '\n') {
      lineStart = true;
      i += 1;
      continue;
    }
    if (lineStart && (c === ' ' || c === '\t' || c === '\r')) {
      i += 1;
      continue;
    }
    if (lineStart && c === '#') {
      // A directive runs to the end of the line, including backslash continuations.
      while (i < code.length && code[i] !== '\n') {
        i += code[i] === '\\' && (code[i + 1] === '\n' || code[i + 1] === '\r') ? (code[i + 1] === '\r' ? 3 : 2) : 1;
      }
      continue;
    }
    lineStart = false;
    if (code.startsWith('//', i) || code.startsWith('/*', i)) {
      i = skipSpace(code, i);
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (isIdentPart(code[j])) j += 1;
      if (RECORD_WORDS.has(code.slice(i, j)) && opensDefinition(code, j)) {
        inserts.push(syntax === 'attribute' ? { at: j, text: ' __attribute__((packed))' } : { at: i, text: '__packed ' });
      }
      i = j;
      continue;
    }
    i += 1;
  }

  let out = code;
  for (const { at, text } of inserts.reverse()) out = out.slice(0, at) + text + out.slice(at);
  return out;
}
