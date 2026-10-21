/**
 * Parser for the parts of a Go source file that define memory layout: type declarations,
 * constants (for array lengths, including iota), and imports (to resolve qualified type names).
 * Function and variable declarations are skipped.
 *
 * Follows the Go spec: automatic semicolon insertion, the full type grammar, embedded fields,
 * struct tags, aliases, and generic type declarations with instantiation.
 */
import type { ParseError } from '../types';
import { ConstExprError, evaluateConstExpr } from '../parser/const-expr';
import { stripComments } from '../parser/preprocess';
import { findClosing, tokenize } from '../parser/tokens';
import type { Token } from '../parser/tokens';

export type GoType =
  | { kind: 'name'; name: string; pkg?: string; typeArgs?: GoType[] }
  | { kind: 'pointer'; elem: GoType }
  | { kind: 'slice'; elem: GoType }
  | { kind: 'array'; length: number; elem: GoType }
  | { kind: 'map'; key: GoType; value: GoType }
  | { kind: 'chan'; elem: GoType; dir: 'both' | 'send' | 'recv' }
  | { kind: 'func'; signature: string }
  | { kind: 'interface'; empty: boolean; /** Source text, e.g. 'interface{ M() }'. */ source: string }
  | { kind: 'struct'; fields: GoField[] };

export interface GoField {
  /** Field name; for an embedded field, the type's name. '_' for blank fields. */
  name: string;
  embedded: boolean;
  type: GoType;
  /** Struct tag as written, including its quotes. */
  tag?: string;
  line: number;
}

export interface GoTypeDecl {
  name: string;
  /** `type A = B`: an alias, not a new type. */
  alias: boolean;
  typeParams: string[];
  type: GoType;
  line: number;
}

export interface GoFile {
  packageName?: string;
  /** Import name (alias or last path element) -> import path. */
  imports: Map<string, string>;
  types: Map<string, GoTypeDecl>;
  /** Type declaration names in source order. */
  order: string[];
  consts: Map<string, number>;
  errors: ParseError[];
  warnings: ParseError[];
}

class Recover extends Error {}

/** Go's automatic semicolon insertion (spec: "Semicolons"). */
function insertSemicolons(tokens: Token[]): Token[] {
  const out: Token[] = [];
  const triggers = new Set(['break', 'continue', 'fallthrough', 'return']);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    out.push(t);
    const next = tokens[i + 1];
    const endsLine = !next || next.line > t.line;
    if (!endsLine) continue;
    const qualifies =
      (t.kind === 'id' && (triggers.has(t.value) || !GO_KEYWORDS.has(t.value))) ||
      t.kind === 'num' || t.kind === 'str' || t.kind === 'char' ||
      (t.kind === 'punct' && [')', ']', '}', '++', '--'].includes(t.value));
    if (qualifies) out.push({ kind: 'punct', value: ';', line: t.line });
  }
  return out;
}

const GO_KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for',
  'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select',
  'struct', 'switch', 'type', 'var',
]);

/** Go operators the shared C evaluator lacks: unary ^ (bitwise not) and &^ (and-not). */
function toCExpression(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'punct' && t.value === '&' && tokens[i + 1]?.value === '^') {
      out.push(t, { ...tokens[i + 1], value: '~' });
      i += 1;
      continue;
    }
    if (t.kind === 'punct' && t.value === '^') {
      const prev = out[out.length - 1];
      const unary = !prev || (prev.kind === 'punct' && prev.value !== ')');
      out.push(unary ? { ...t, value: '~' } : t);
      continue;
    }
    out.push(t);
  }
  return out;
}

export function parseGo(code: string): GoFile {
  const file: GoFile = {
    imports: new Map(),
    types: new Map(),
    order: [],
    consts: new Map(),
    errors: [],
    warnings: [],
  };
  const tokens = insertSemicolons(tokenize(stripComments(code)));
  let pos = 0;

  const peek = (o = 0) => tokens[pos + o];
  const is = (v: string, o = 0) => {
    const t = tokens[pos + o];
    return !!t && (t.kind === 'punct' || t.kind === 'id') && t.value === v;
  };
  const line = () => (peek() ?? tokens[tokens.length - 1])?.line ?? 1;
  const fail = (message: string, at = line()): never => {
    file.errors.push({ message, line: at, type: 'syntax' });
    throw new Recover();
  };
  const expect = (v: string, what: string) => {
    if (!is(v)) fail(`Expected '${v}' ${what}${peek() ? ` but found '${peek()!.value}'` : ''}.`);
    pos += 1;
  };
  const ident = (what: string): string => {
    const t = peek();
    if (t?.kind !== 'id' || GO_KEYWORDS.has(t.value)) fail(`Expected ${what}${t ? ` but found '${t.value}'` : ''}.`);
    pos += 1;
    return t!.value;
  };
  const skipStatement = () => {
    while (pos < tokens.length && !is(';')) {
      if (is('(') || is('[') || is('{')) {
        const close = findClosing(tokens, pos);
        pos = close === -1 ? tokens.length : close + 1;
      } else {
        pos += 1;
      }
    }
    if (is(';')) pos += 1;
  };

  const constValue = (exprTokens: Token[], iota: number): number | undefined => {
    if (exprTokens.length === 0) return undefined;
    try {
      return evaluateConstExpr(toCExpression(exprTokens), (name) => (name === 'iota' ? iota : file.consts.get(name)));
    } catch (err) {
      // Non-integer constants (strings, floats) are fine as long as no array length uses them.
      if (!(err instanceof ConstExprError)) throw err;
      return undefined;
    }
  };

  // ------------------------------------------------------------------ types

  const parseTypeList = (close: number): GoType[] => {
    const list: GoType[] = [];
    while (pos < close) {
      list.push(parseType());
      if (is(',')) pos += 1;
    }
    pos = close + 1;
    return list;
  };

  const parseType = (): GoType => {
    const t = peek();
    if (!t) fail('Expected a type.');
    const at = t!.line;
    if (is('*')) {
      pos += 1;
      return { kind: 'pointer', elem: parseType() };
    }
    if (is('(')) {
      pos += 1;
      const inner = parseType();
      expect(')', 'to close the parenthesized type');
      return inner;
    }
    if (is('[')) {
      if (is(']', 1)) {
        pos += 2;
        return { kind: 'slice', elem: parseType() };
      }
      const close = findClosing(tokens, pos);
      if (close === -1) fail("Missing ']' in array type.");
      const lenTokens = tokens.slice(pos + 1, close);
      if (lenTokens.length === 1 && lenTokens[0].value === '...') fail('[...]T is only allowed in composite literals, not in a type.', at);
      const length = constValue(lenTokens, 0);
      if (length === undefined) {
        fail(`Array length '${lenTokens.map((x) => x.value).join(' ')}' is not an integer constant.`, at);
      }
      if (length! < 0) fail(`Array length ${length} is negative.`, at);
      pos = close + 1;
      return { kind: 'array', length: length!, elem: parseType() };
    }
    if (is('map')) {
      pos += 1;
      expect('[', "after 'map'");
      const key = parseType();
      expect(']', 'after the map key type');
      return { kind: 'map', key, value: parseType() };
    }
    if (is('<') && is('-', 1) && is('chan', 2)) {
      pos += 3;
      return { kind: 'chan', elem: parseType(), dir: 'recv' };
    }
    if (is('chan')) {
      pos += 1;
      let dir: 'both' | 'send' = 'both';
      if (is('<') && is('-', 1)) {
        pos += 2;
        dir = 'send';
      }
      return { kind: 'chan', elem: parseType(), dir };
    }
    if (is('func')) {
      pos += 1;
      if (!is('(')) fail("Expected '(' after 'func'.");
      let end = findClosing(tokens, pos);
      const parts: string[] = [`func${tokensText(tokens.slice(pos, end + 1))}`];
      pos = end + 1;
      // Result: a parenthesized list or a single type, if one follows on this line.
      if (is('(')) {
        end = findClosing(tokens, pos);
        parts.push(tokensText(tokens.slice(pos, end + 1)));
        pos = end + 1;
      } else if (peek() && !is(';') && !is(',') && !is(')') && !is(']') && !is('}') && peek()!.kind !== 'str') {
        const start = pos;
        parseType();
        parts.push(tokensText(tokens.slice(start, pos)));
      }
      return { kind: 'func', signature: parts.join(' ') };
    }
    if (is('interface')) {
      pos += 1;
      if (!is('{')) fail("Expected '{' after 'interface'.");
      const close = findClosing(tokens, pos);
      const body = tokens.slice(pos + 1, close);
      const empty = body.every((x) => x.value === ';');
      const elems = splitStatements(body).map(tokensText);
      pos = close + 1;
      return { kind: 'interface', empty, source: empty ? 'interface{}' : `interface{ ${elems.join('; ')} }` };
    }
    if (is('struct')) {
      pos += 1;
      return { kind: 'struct', fields: parseStructBody() };
    }
    if (t!.kind === 'id' && !GO_KEYWORDS.has(t!.value)) {
      pos += 1;
      let name = t!.value;
      let pkg: string | undefined;
      if (is('.') && peek(1)?.kind === 'id') {
        pkg = name;
        name = peek(1)!.value;
        pos += 2;
      }
      const type: GoType = { kind: 'name', name, pkg };
      if (is('[') && !is(']', 1)) {
        const close = findClosing(tokens, pos);
        pos += 1;
        type.typeArgs = parseTypeList(close);
      }
      return type;
    }
    return fail(`Expected a type but found '${t!.value}'.`, at);
  };

  const tag = (): string | undefined => {
    const t = peek();
    if (t?.kind !== 'str') return undefined;
    pos += 1;
    return t.value;
  };

  const parseStructBody = (): GoField[] => {
    expect('{', "after 'struct'");
    const close = findClosing(tokens, pos - 1);
    if (close === -1) fail("Missing '}' to close the struct.");
    const fields: GoField[] = [];
    while (pos < close) {
      if (is(';')) {
        pos += 1;
        continue;
      }
      const at = line();
      const t = peek()!;
      // Embedded field: T, *T, pkg.T, T[Args] (each optionally followed by a tag).
      const embeddedEnd = (o: number) => is(';', o) || peek(o)?.kind === 'str' || pos + o >= close;
      const isEmbedded =
        is('*') ||
        (t.kind === 'id' && (embeddedEnd(1) || (is('.', 1) && peek(2)?.kind === 'id'))) ||
        (t.kind === 'id' && is('[', 1) && embeddedEnd(findClosing(tokens, pos + 1) - pos + 1));
      if (isEmbedded) {
        const type = parseType();
        const base = type.kind === 'pointer' ? type.elem : type;
        const name = base.kind === 'name' ? base.name : '?';
        fields.push({ name, embedded: true, type, tag: tag(), line: at });
      } else {
        const names = [ident('a field name')];
        while (is(',')) {
          pos += 1;
          names.push(ident('a field name'));
        }
        const type = parseType();
        const fieldTag = tag();
        for (const name of names) fields.push({ name, embedded: false, type, tag: fieldTag, line: at });
      }
      if (is(';')) pos += 1;
      else if (pos < close) fail(`Expected a new line or ';' after field '${fields[fields.length - 1].name}' but found '${peek()!.value}'.`);
    }
    pos = close + 1;
    return fields;
  };

  // ------------------------------------------------------------------ declarations

  const parseTypeSpec = () => {
    const at = line();
    const name = ident('a type name');
    const typeParams: string[] = [];
    // `type T[K comparable, V any] ...` (type parameters) versus `type T [N]int` (array): a
    // parameter list has a name followed by a constraint or a comma; an array length does not.
    if (is('[') && peek(1)?.kind === 'id' && !is(']', 2)) {
      const second = peek(2)!;
      const isParams = second.kind === 'id' || second.value === ',' || second.value === '~' || second.value === '[';
      if (isParams) {
        const close = findClosing(tokens, pos);
        // TypeParamDecl = IdentifierList TypeConstraint, so every comma-separated part starts with a name.
        for (const part of splitTopLevel(tokens.slice(pos + 1, close))) typeParams.push(part[0].value);
        pos = close + 1;
      }
    }
    const alias = is('=');
    if (alias) pos += 1;
    const type = parseType();
    if (file.types.has(name)) {
      file.errors.push({ message: `Type '${name}' is declared more than once.`, line: at, type: 'semantic' });
    }
    file.types.set(name, { name, alias, typeParams, type, line: at });
    file.order.push(name);
  };

  const parseConstGroup = (single: boolean) => {
    let iota = 0;
    let previous: Token[] = [];
    const parseSpec = () => {
      const names = [ident('a constant name')];
      while (is(',')) {
        pos += 1;
        names.push(ident('a constant name'));
      }
      // Optional type (ignored: typed and untyped constants have the same value), then optional
      // "= exprs"; without "=", the previous expression list repeats with the next iota.
      while (pos < tokens.length && !is('=') && !is(';') && !is(')')) pos += 1;
      let exprs: Token[][] = [];
      if (is('=')) {
        pos += 1;
        const all: Token[] = [];
        while (pos < tokens.length && !is(';') && !(is(')') && single === false && depthOf(all) === 0)) {
          if (is('(') || is('[') || is('{')) {
            const close = findClosing(tokens, pos);
            all.push(...tokens.slice(pos, close + 1));
            pos = close + 1;
            continue;
          }
          all.push(tokens[pos]);
          pos += 1;
        }
        exprs = splitTopLevel(all);
        previous = all;
      } else {
        exprs = splitTopLevel(previous);
      }
      names.forEach((n, i) => {
        if (n === '_') return;
        const value = constValue(exprs[i] ?? [], iota);
        if (value !== undefined) file.consts.set(n, value);
        else file.consts.delete(n);
      });
      iota += 1;
      if (is(';')) pos += 1;
    };
    if (single) {
      parseSpec();
      return;
    }
    expect('(', "after 'const'");
    while (pos < tokens.length && !is(')')) {
      if (is(';')) { pos += 1; continue; }
      parseSpec();
    }
    expect(')', 'to close the const group');
  };

  while (pos < tokens.length) {
    const start = pos;
    try {
      if (is(';')) {
        pos += 1;
      } else if (is('package')) {
        pos += 1;
        file.packageName = ident('a package name');
      } else if (is('import')) {
        pos += 1;
        const one = () => {
          let alias: string | undefined;
          if (peek()?.kind === 'id' || is('.') || is('_')) {
            alias = peek()!.value;
            pos += 1;
          }
          const pathTok = peek();
          if (pathTok?.kind !== 'str') fail('Expected an import path.');
          pos += 1;
          const path = pathTok!.value.slice(1, -1);
          const name = alias ?? path.split('/').pop()!;
          if (name !== '_' && name !== '.') file.imports.set(name, path);
        };
        if (is('(')) {
          pos += 1;
          while (pos < tokens.length && !is(')')) {
            if (is(';')) { pos += 1; continue; }
            one();
          }
          expect(')', 'to close the import group');
        } else {
          one();
        }
      } else if (is('type')) {
        pos += 1;
        if (is('(')) {
          pos += 1;
          while (pos < tokens.length && !is(')')) {
            if (is(';')) { pos += 1; continue; }
            parseTypeSpec();
            if (is(';')) pos += 1;
          }
          expect(')', 'to close the type group');
        } else {
          parseTypeSpec();
        }
      } else if (is('const')) {
        pos += 1;
        parseConstGroup(!is('('));
      } else if (is('func')) {
        // Skip to the body and past it (or to the end of a body-less declaration).
        while (pos < tokens.length && !is('{') && !is(';')) {
          if (is('(') || is('[')) pos = findClosing(tokens, pos) + 1;
          else pos += 1;
        }
        if (is('{')) pos = findClosing(tokens, pos) + 1;
      } else if (is('var')) {
        pos += 1;
        skipStatement();
      } else {
        fail(`Unexpected '${peek()!.value}' at the top level.`);
      }
    } catch (err) {
      if (!(err instanceof Recover)) throw err;
      pos = Math.max(pos, start + 1);
      skipStatement();
    }
    if (pos === start) pos += 1;
  }

  return file;
}

function depthOf(tokens: Token[]): number {
  let d = 0;
  for (const t of tokens) {
    if (t.value === '(' || t.value === '[' || t.value === '{') d += 1;
    if (t.value === ')' || t.value === ']' || t.value === '}') d -= 1;
  }
  return d;
}

function splitTopLevel(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
    if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
    if (depth === 0 && t.value === ',') {
      out.push([]);
      continue;
    }
    out[out.length - 1].push(t);
  }
  return out.filter((e) => e.length > 0);
}

/** Splits tokens at top-level ';' (inserted or written), dropping empty statements. */
function splitStatements(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
    if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
    if (depth === 0 && t.value === ';') {
      out.push([]);
      continue;
    }
    out[out.length - 1].push(t);
  }
  return out.filter((s) => s.length > 0);
}

/** Tokens back to gofmt-style source text, for func signatures and interface bodies. */
function tokensText(tokens: Token[]): string {
  const word = (t: Token | undefined) => !!t && t.kind !== 'punct';
  const name = (t: Token | undefined) => !!t && t.kind === 'id' && !GO_KEYWORDS.has(t.value);
  let out = '';
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const space =
      !!prev &&
      ((word(prev) && word(t)) ||
        prev.value === ',' ||
        (prev.value === ')' && (word(t) || t.value === '(' || t.value === '*' || t.value === '[')) ||
        // A parameter name before its type: `p *T`, `p []T`, `p [4]T`, `p ...T`, `f func()`.
        (name(prev) && (t.value === '*' || t.value === '...' || (t.value === '[' && (next?.value === ']' || next?.kind === 'num')))));
    out += (space ? ' ' : '') + t.value;
  });
  return out;
}

/** Canonical Go source text for a type, e.g. "map[string][]*T". */
export function formatGoType(type: GoType): string {
  switch (type.kind) {
    case 'name':
      return `${type.pkg ? `${type.pkg}.` : ''}${type.name}${type.typeArgs ? `[${type.typeArgs.map(formatGoType).join(', ')}]` : ''}`;
    case 'pointer':
      return `*${formatGoType(type.elem)}`;
    case 'slice':
      return `[]${formatGoType(type.elem)}`;
    case 'array':
      return `[${type.length}]${formatGoType(type.elem)}`;
    case 'map':
      return `map[${formatGoType(type.key)}]${formatGoType(type.value)}`;
    case 'chan':
      return type.dir === 'recv' ? `<-chan ${formatGoType(type.elem)}` : type.dir === 'send' ? `chan<- ${formatGoType(type.elem)}` : `chan ${formatGoType(type.elem)}`;
    case 'func':
      return type.signature;
    case 'interface':
      return type.source;
    case 'struct':
      return type.fields.length === 0
        ? 'struct{}'
        : `struct{ ${type.fields.map((f) => (f.embedded ? formatGoType(f.type) : `${f.name} ${formatGoType(f.type)}`)).join('; ')} }`;
  }
}
