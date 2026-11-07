/**
 * Parser for Go source files, following the spec's grammar: package clause, imports, and the
 * type, const, var and func declarations of a package. Types and constant expressions are parsed
 * in full (they define memory layout: array lengths are constant expressions); function bodies
 * are skipped by brace matching over the tokens.
 *
 * Covers automatic semicolon insertion (in the lexer), the full type grammar, embedded fields,
 * struct tags, aliases, generic type declarations with instantiation, and Go's expression syntax.
 */
import type { ParseError } from '../types';
import { Nesting, NestingError } from '../nesting';
import { GO_KEYWORDS, findClosing, lexGo } from './lexer';
import type { GoToken } from './lexer';

export type GoType =
  | { kind: 'name'; name: string; pkg?: string; typeArgs?: GoType[] }
  | { kind: 'pointer'; elem: GoType }
  | { kind: 'slice'; elem: GoType }
  /** `[N]T`, with the length as written; `[...]T` (length `ellipsis`) only in composite literals. */
  | { kind: 'array'; length: GoExpr; elem: GoType }
  | { kind: 'map'; key: GoType; value: GoType }
  | { kind: 'chan'; elem: GoType; dir: 'both' | 'send' | 'recv' }
  /** Parameter and result types, one per name; a variadic last parameter `...T` is []T. */
  | { kind: 'func'; signature: string; params: GoType[]; results: GoType[]; variadic: boolean }
  | {
      kind: 'interface';
      empty: boolean;
      /** Source text, e.g. 'interface{ M() }'. */
      source: string;
      methods: Array<{ name: string; type: Extract<GoType, { kind: 'func' }> }>;
      /** Embedded elements: each a union of terms (`~int | string`). */
      embedded: Array<Array<{ tilde: boolean; type: GoType }>>;
    }
  | { kind: 'struct'; fields: GoField[] };

/** An expression (spec: "Expressions"), as parsed; the layout engine evaluates constants. */
export type GoExpr =
  | { kind: 'lit'; tok: 'int' | 'float' | 'imag' | 'char' | 'str'; value: string }
  | { kind: 'ident'; name: string }
  | { kind: 'paren'; x: GoExpr }
  | { kind: 'selector'; x: GoExpr; sel: string }
  | { kind: 'index'; x: GoExpr; indices: GoExpr[] }
  | { kind: 'slice'; x: GoExpr; indices: Array<GoExpr | null> }
  | { kind: 'assert'; x: GoExpr; type: GoType | null }
  | { kind: 'call'; fun: GoExpr; args: GoExpr[]; ellipsis: boolean }
  | { kind: 'star'; x: GoExpr }
  | { kind: 'unary'; op: string; x: GoExpr }
  | { kind: 'binary'; op: string; x: GoExpr; y: GoExpr }
  /** `T{...}`; `type` is absent for an elided literal type inside another literal. */
  | { kind: 'composite'; type?: GoExpr; elems: GoExpr[] }
  | { kind: 'keyvalue'; key: GoExpr; value: GoExpr }
  /** A type literal in expression position: `[4]int{}`, `[]byte("x")`, `struct{}{}`. */
  | { kind: 'type'; type: GoType }
  | { kind: 'funclit'; type: Extract<GoType, { kind: 'func' }> }
  /** The `...` length of `[...]T{...}`. */
  | { kind: 'ellipsis' };

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

export interface GoConstDecl {
  name: string;
  /** The declared type; absent for an untyped constant. */
  type?: GoType;
  expr: GoExpr;
  /** Value of iota in this ConstSpec. */
  iota: number;
  line: number;
}

export interface GoVarDecl {
  name: string;
  type?: GoType;
  /** The initializer, when there is one expression per name. */
  expr?: GoExpr;
  line: number;
}

export interface GoFile {
  packageName?: string;
  /** Import name (alias or last path element) -> import path. */
  imports: Map<string, string>;
  types: Map<string, GoTypeDecl>;
  /** Type declaration names in source order. */
  order: string[];
  consts: Map<string, GoConstDecl>;
  vars: Map<string, GoVarDecl>;
  errors: ParseError[];
}

class ParseFail extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

/** Binary operator precedences (spec: "Operator precedence"). */
export const GO_BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  '+': 4, '-': 4, '|': 4, '^': 4,
  '*': 5, '/': 5, '%': 5, '<<': 5, '>>': 5, '&': 5, '&^': 5,
};

const describe = (t: GoToken | undefined) => (!t ? 'the end of the input' : t.inserted ? 'a new line' : `'${t.value}'`);

export function parseGo(code: string): GoFile {
  const lexed = lexGo(code);
  const file: GoFile = {
    imports: new Map(),
    types: new Map(),
    order: [],
    consts: new Map(),
    vars: new Map(),
    errors: [...lexed.errors],
  };
  const tokens = lexed.tokens;
  let pos = 0;

  const peek = (o = 0) => tokens[pos + o];
  const is = (v: string, o = 0) => {
    const t = tokens[pos + o];
    return !!t && (t.kind === 'punct' || t.kind === 'id') && t.value === v;
  };
  const line = () => (peek() ?? tokens[tokens.length - 1])?.line ?? 1;
  const fail = (message: string, at = line()): never => {
    throw new ParseFail(message, at);
  };
  const expect = (v: string, what: string) => {
    if (!is(v)) fail(`Expected '${v}' ${what} but found ${describe(peek())}.`);
    pos += 1;
  };
  const isName = (o = 0) => {
    const t = peek(o);
    return t?.kind === 'id' && !GO_KEYWORDS.has(t.value);
  };
  const ident = (what: string): string => {
    if (!isName()) fail(`Expected ${what} but found ${describe(peek())}.`);
    pos += 1;
    return tokens[pos - 1].value;
  };
  const closing = (at: number, what: string) => {
    const close = findClosing(tokens, at);
    if (close === -1) fail(`Missing '${tokens[at].value === '(' ? ')' : tokens[at].value === '[' ? ']' : '}'}' ${what}.`, tokens[at].line);
    return close;
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
  /** Whether a type can start here (go/parser's tryIdentOrType). */
  const startsType = () =>
    isName() || ['[', 'struct', '*', 'func', 'interface', 'map', 'chan', '(', '<-'].some((v) => is(v));

  // ------------------------------------------------------------------ types

  /** Every nested type and operand is one level deeper (nesting.ts). */
  const nesting = new Nesting();
  const parseType = (allowEllipsis = false): GoType => nesting.in(() => parseTypeHere(allowEllipsis), line());
  const parseTypeHere = (allowEllipsis: boolean): GoType => {
    const t = peek();
    if (!t) fail('Expected a type but found the end of the input.');
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
      pos += 1;
      if (is(']')) {
        pos += 1;
        return { kind: 'slice', elem: parseType() };
      }
      let length: GoExpr;
      if (is('...') && is(']', 1)) {
        if (!allowEllipsis) fail('[...]T is only allowed in composite literals, not in a type.', at);
        pos += 1;
        length = { kind: 'ellipsis' };
      } else {
        length = parseExpr();
      }
      expect(']', 'to close the array length');
      return { kind: 'array', length, elem: parseType() };
    }
    if (is('map')) {
      pos += 1;
      expect('[', "after 'map'");
      const key = parseType();
      expect(']', 'after the map key type');
      return { kind: 'map', key, value: parseType() };
    }
    if (is('<-')) {
      pos += 1;
      if (!is('chan')) fail(`Expected 'chan' after '<-' but found ${describe(peek())}.`);
      pos += 1;
      return { kind: 'chan', elem: parseType(), dir: 'recv' };
    }
    if (is('chan')) {
      pos += 1;
      let dir: 'both' | 'send' = 'both';
      if (is('<-')) {
        pos += 1;
        dir = 'send';
      }
      return { kind: 'chan', elem: parseType(), dir };
    }
    if (is('func')) {
      pos += 1;
      return parseSignature('func');
    }
    if (is('interface')) {
      pos += 1;
      return parseInterface();
    }
    if (is('struct')) {
      pos += 1;
      return { kind: 'struct', fields: parseStructBody() };
    }
    if (isName()) {
      pos += 1;
      let name = t!.value;
      let pkg: string | undefined;
      if (is('.') && isName(1)) {
        pkg = name;
        name = peek(1)!.value;
        pos += 2;
      }
      const type: GoType = { kind: 'name', name, pkg };
      if (is('[') && !is(']', 1)) {
        const close = closing(pos, 'to close the type arguments');
        pos += 1;
        type.typeArgs = [];
        while (pos < close) {
          type.typeArgs.push(parseType());
          if (is(',')) pos += 1;
          else if (pos < close) fail(`Expected ',' or ']' in the type arguments but found ${describe(peek())}.`);
        }
        pos = close + 1;
      }
      return type;
    }
    return fail(`Expected a type but found ${describe(t)}.`, at);
  };

  /** Parameters (spec: "Function types"): all parameters are named, or none is. */
  const parseParameters = (): { types: GoType[]; variadic: boolean } => {
    expect('(', 'to start the parameters');
    type Entry = { name?: string; type: GoType; variadic: boolean; bare?: string };
    const entries: Entry[] = [];
    while (!is(')')) {
      if (pos >= tokens.length) fail("Missing ')' to close the parameters.");
      if (isName() && (is('...', 1) || (startsTypeAt(1) && !is('.', 1)))) {
        // `name Type` or `name ...Type`; `G[int]` is a type, `a [4]int` a named parameter.
        const save = pos;
        const name = tokens[pos].value;
        pos += 1;
        const variadic = is('...');
        if (variadic) pos += 1;
        if (!variadic && is('[')) {
          // Named only if a whole type follows and ends the entry.
          let named: GoType | undefined;
          try {
            const type = parseType();
            if (is(',') || is(')')) named = type;
          } catch (err) {
            if (!(err instanceof ParseFail)) throw err;
          }
          if (named) {
            entries.push({ name, type: named, variadic: false });
          } else {
            pos = save;
            entries.push({ type: parseType(), variadic: false });
          }
        } else {
          entries.push({ name, type: parseType(), variadic });
        }
      } else {
        const variadic = is('...');
        if (variadic) pos += 1;
        const start = pos;
        const type = parseType();
        const bare = type.kind === 'name' && !type.pkg && !type.typeArgs && pos === start + 1 ? type.name : undefined;
        entries.push({ type, variadic, bare });
      }
      if (is(',')) pos += 1;
      else if (!is(')')) fail(`Expected ',' or ')' in the parameters but found ${describe(peek())}.`);
    }
    pos += 1;
    const named = entries.some((e) => e.name !== undefined);
    const types: GoType[] = [];
    let variadic = false;
    let pending = 0;
    entries.forEach((e, i) => {
      if (named && e.name === undefined) {
        // In a named list, a lone identifier names a parameter of the next entry's type.
        if (e.bare === undefined || e.variadic) fail('Mixed named and unnamed parameters.');
        pending += 1;
        if (i === entries.length - 1) fail('Mixed named and unnamed parameters.');
        return;
      }
      const type: GoType = e.variadic ? { kind: 'slice', elem: e.type } : e.type;
      if (e.variadic) {
        if (i !== entries.length - 1 || pending > 0) fail('Can only use ... with the final parameter in the list.');
        variadic = true;
      }
      for (let k = 0; k <= pending; k++) types.push(type);
      pending = 0;
    });
    return { types, variadic };
  };
  const startsTypeAt = (o: number) => {
    const save = pos;
    pos += o;
    const r = startsType();
    pos = save;
    return r;
  };

  /** Parameters and result, after `func` (or a method name). */
  const parseSignature = (prefix: string): Extract<GoType, { kind: 'func' }> => {
    const start = pos;
    if (!is('(')) fail(`Expected '(' after '${prefix}' but found ${describe(peek())}.`);
    const params = parseParameters();
    let results: GoType[] = [];
    if (is('(')) {
      results = parseParameters().types;
    } else if (startsType()) {
      results = [parseType()];
    }
    const signature = `${prefix}${tokensText(tokens.slice(start, pos))}`;
    return { kind: 'func', signature, params: params.types, results, variadic: params.variadic };
  };

  const parseInterface = (): Extract<GoType, { kind: 'interface' }> => {
    if (!is('{')) fail(`Expected '{' after 'interface' but found ${describe(peek())}.`);
    const close = closing(pos, 'to close the interface');
    const body = tokens.slice(pos + 1, close);
    pos += 1;
    const methods: Array<{ name: string; type: Extract<GoType, { kind: 'func' }> }> = [];
    const embedded: Array<Array<{ tilde: boolean; type: GoType }>> = [];
    while (pos < close) {
      if (is(';')) {
        pos += 1;
        continue;
      }
      if (isName() && is('(', 1)) {
        const name = tokens[pos].value;
        pos += 1;
        methods.push({ name, type: parseSignature(name) });
      } else {
        const terms: Array<{ tilde: boolean; type: GoType }> = [];
        do {
          if (terms.length > 0) pos += 1;
          const tilde = is('~');
          if (tilde) pos += 1;
          terms.push({ tilde, type: parseType() });
        } while (is('|'));
        embedded.push(terms);
      }
      if (is(';')) pos += 1;
      else if (pos < close) fail(`Expected a new line or ';' in the interface but found ${describe(peek())}.`);
    }
    pos = close + 1;
    const empty = methods.length === 0 && embedded.length === 0;
    const elems = splitStatements(body).map(tokensText);
    return { kind: 'interface', empty, source: empty ? 'interface{}' : `interface{ ${elems.join('; ')} }`, methods, embedded };
  };

  const tag = (): string | undefined => {
    const t = peek();
    if (t?.kind !== 'str') return undefined;
    pos += 1;
    return t.value;
  };

  const parseStructBody = (): GoField[] => {
    if (!is('{')) fail(`Expected '{' after 'struct' but found ${describe(peek())}.`);
    const close = closing(pos, 'to close the struct');
    pos += 1;
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
        (t.kind === 'id' && (embeddedEnd(1) || (is('.', 1) && isName(2)))) ||
        (t.kind === 'id' && is('[', 1) && embeddedEnd(findClosing(tokens, pos + 1) - pos + 1));
      if (isEmbedded) {
        const type = parseType();
        const base = type.kind === 'pointer' ? type.elem : type;
        if (base.kind !== 'name') fail('An embedded field must be a type name or a pointer to one.', at);
        fields.push({ name: (base as Extract<GoType, { kind: 'name' }>).name, embedded: true, type, tag: tag(), line: at });
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
      else if (pos < close) fail(`Expected a new line or ';' after field '${fields[fields.length - 1].name}' but found ${describe(peek())}.`);
    }
    pos = close + 1;
    return fields;
  };

  // ------------------------------------------------------------------ expressions

  const parseExpr = (prec1 = 1): GoExpr => {
    let x = parseUnary();
    for (;;) {
      const t = peek();
      const prec = t?.kind === 'punct' ? GO_BINARY_PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < prec1) return x;
      pos += 1;
      const y = parseExpr(prec + 1);
      x = { kind: 'binary', op: t!.value, x, y };
    }
  };

  const parseUnary = (): GoExpr => nesting.in(() => parseUnaryHere(), line());
  const parseUnaryHere = (): GoExpr => {
    if (is('*')) {
      pos += 1;
      return { kind: 'star', x: parseUnary() };
    }
    for (const op of ['+', '-', '!', '^', '&', '<-']) {
      if (is(op)) {
        // `<-chan T` in expression position is a type.
        if (op === '<-' && is('chan', 1)) break;
        pos += 1;
        return { kind: 'unary', op, x: parseUnary() };
      }
    }
    return parsePrimary();
  };

  /** Comma-separated expressions (or types) up to `close`, which is consumed. */
  const parseList = (close: string, what: string): { list: GoExpr[]; ellipsis: boolean } => {
    const list: GoExpr[] = [];
    let ellipsis = false;
    while (!is(close)) {
      if (pos >= tokens.length) fail(`Missing '${close}' ${what}.`);
      list.push(parseExpr());
      if (is('...')) {
        ellipsis = true;
        pos += 1;
      }
      if (is(',')) pos += 1;
      else if (!is(close)) fail(`Expected ',' or '${close}' ${what} but found ${describe(peek())}.`);
    }
    pos += 1;
    return { list, ellipsis };
  };

  const parseLiteralValue = (type?: GoExpr): GoExpr => {
    expect('{', 'to start the composite literal');
    const elems: GoExpr[] = [];
    while (!is('}')) {
      if (pos >= tokens.length) fail("Missing '}' to close the composite literal.");
      const element = () => (is('{') ? nesting.in(() => parseLiteralValue(), line()) : parseExpr());
      const first = element();
      if (is(':')) {
        pos += 1;
        elems.push({ kind: 'keyvalue', key: first, value: element() });
      } else {
        elems.push(first);
      }
      if (is(',')) pos += 1;
      else if (!is('}')) fail(`Expected ',' or '}' in the composite literal but found ${describe(peek())}.`);
    }
    pos += 1;
    return { kind: 'composite', type, elems };
  };

  /** Whether `x` can be the type of a composite literal: T, pkg.T, T[A], or a type literal. */
  const literalType = (x: GoExpr): boolean =>
    x.kind === 'ident' ||
    (x.kind === 'selector' && x.x.kind === 'ident') ||
    (x.kind === 'index' && literalType(x.x)) ||
    (x.kind === 'type' && ['array', 'slice', 'map', 'struct', 'name'].includes(x.type.kind));

  const parsePrimary = (): GoExpr => {
    let x = parseOperand();
    for (;;) {
      if (is('.')) {
        if (isName(1)) {
          x = { kind: 'selector', x, sel: peek(1)!.value };
          pos += 2;
        } else if (is('(', 1)) {
          pos += 2;
          let type: GoType | null = null;
          if (is('type')) pos += 1;
          else type = parseType();
          expect(')', 'to close the type assertion');
          x = { kind: 'assert', x, type };
        } else {
          fail(`Expected a name after '.' but found ${describe(peek(1))}.`);
        }
      } else if (is('[')) {
        pos += 1;
        const indices: Array<GoExpr | null> = [];
        let colons = 0;
        while (!is(']')) {
          if (pos >= tokens.length) fail("Missing ']' to close the index.");
          if (is(':')) {
            if (indices.length === colons) indices.push(null);
            colons += 1;
            pos += 1;
            continue;
          }
          indices.push(parseExpr());
          if (is(',') && colons === 0) pos += 1;
          else if (!is(']') && !is(':')) fail(`Expected ']' to close the index but found ${describe(peek())}.`);
        }
        pos += 1;
        if (colons > 0) {
          while (indices.length <= colons) indices.push(null);
          x = { kind: 'slice', x, indices };
        } else {
          if (indices.length === 0) fail('Expected an index or type argument.');
          x = { kind: 'index', x, indices: indices as GoExpr[] };
        }
      } else if (is('(')) {
        pos += 1;
        const { list, ellipsis } = parseList(')', 'to close the call');
        x = { kind: 'call', fun: x, args: list, ellipsis };
      } else if (is('{') && literalType(x)) {
        x = parseLiteralValue(x);
      } else {
        return x;
      }
    }
  };

  const parseOperand = (): GoExpr => {
    const t = peek();
    if (!t) return fail('Expected an expression but found the end of the input.');
    if (t.kind === 'int' || t.kind === 'float' || t.kind === 'imag' || t.kind === 'char' || t.kind === 'str') {
      pos += 1;
      return { kind: 'lit', tok: t.kind, value: t.value };
    }
    if (isName()) {
      pos += 1;
      return { kind: 'ident', name: t.value };
    }
    if (is('(')) {
      pos += 1;
      const x = parseExpr();
      expect(')', 'to close the parenthesized expression');
      return { kind: 'paren', x };
    }
    if (is('func')) {
      pos += 1;
      const type = parseSignature('func');
      if (!is('{')) return { kind: 'type', type };
      pos = closing(pos, 'to close the function body') + 1;
      return { kind: 'funclit', type };
    }
    if (is('[')) {
      const type = parseType(true);
      if (!is('{') && type.kind === 'array' && type.length.kind === 'ellipsis') fail('[...]T is only allowed in composite literals.');
      return { kind: 'type', type };
    }
    if (is('struct') || is('map') || is('chan') || is('interface') || (is('<-') && is('chan', 1))) {
      return { kind: 'type', type: parseType() };
    }
    return fail(`Expected an expression but found ${describe(t)}.`);
  };

  // ------------------------------------------------------------------ declarations

  const declared = new Map<string, number>();
  const declare = (name: string, at: number) => {
    if (name === '_') return;
    if (declared.has(name)) {
      file.errors.push({ message: `'${name}' is declared more than once (first on line ${declared.get(name)}).`, line: at, type: 'semantic' });
    } else {
      declared.set(name, at);
    }
  };

  const parseTypeSpec = () => {
    const at = line();
    const name = ident('a type name');
    const typeParams: string[] = [];
    // `type T[K comparable, V any] ...` (type parameters) versus `type T [N]int` (array): a
    // parameter list has a name followed by a constraint or a comma; an array length does not.
    if (is('[') && isName(1) && !is(']', 2)) {
      const second = peek(2)!;
      const isParams = second.kind === 'id' || second.value === ',' || second.value === '~' || second.value === '[';
      if (isParams) {
        const close = closing(pos, 'to close the type parameters');
        // TypeParamDecl = IdentifierList TypeConstraint, so every comma-separated part starts with a name.
        for (const part of splitTopLevel(tokens.slice(pos + 1, close))) typeParams.push(part[0].value);
        pos = close + 1;
      }
    }
    const alias = is('=');
    if (alias) pos += 1;
    const type = parseType();
    declare(name, at);
    file.types.set(name, { name, alias, typeParams, type, line: at });
    file.order.push(name);
  };

  const identList = (what: string) => {
    const names = [ident(what)];
    while (is(',')) {
      pos += 1;
      names.push(ident(what));
    }
    return names;
  };

  const exprList = () => {
    const list = [parseExpr()];
    while (is(',')) {
      pos += 1;
      list.push(parseExpr());
    }
    return list;
  };

  const endSpec = (group: boolean) => {
    if (is(';')) pos += 1;
    else if (!(group && is(')')) && pos < tokens.length) fail(`Expected a new line or ';' but found ${describe(peek())}.`);
  };

  const parseConstDecl = () => {
    const group = is('(');
    if (group) pos += 1;
    let iota = 0;
    let previous: { type?: GoType; exprs: GoExpr[] } | undefined;
    const spec = () => {
      const at = line();
      const names = identList('a constant name');
      let type: GoType | undefined;
      if (!is('=') && !is(';') && !is(')')) type = parseType();
      let exprs: GoExpr[];
      if (is('=')) {
        pos += 1;
        exprs = exprList();
        previous = { type, exprs };
      } else {
        // Spec: "Within a parenthesized const declaration list the expression list may be
        // omitted from any but the first ConstSpec": the previous list and its type repeat.
        if (type || !previous || !group) fail(`Missing init expression for constant '${names[0]}'.`, at);
        type = previous!.type;
        exprs = previous!.exprs;
      }
      if (exprs.length < names.length) fail(`Missing init expression for constant '${names[exprs.length]}'.`, at);
      if (exprs.length > names.length) fail('Extra init expression in the constant declaration.', at);
      names.forEach((name, i) => {
        declare(name, at);
        if (name !== '_') file.consts.set(name, { name, type, expr: exprs[i], iota, line: at });
      });
      iota += 1;
      if (group) endSpec(true);
    };
    if (!group) {
      spec();
      return;
    }
    while (!is(')')) {
      if (pos >= tokens.length) fail("Missing ')' to close the const group.");
      if (is(';')) {
        pos += 1;
        continue;
      }
      spec();
    }
    pos += 1;
  };

  const parseVarDecl = () => {
    const group = is('(');
    if (group) pos += 1;
    const spec = () => {
      const at = line();
      const names = identList('a variable name');
      let type: GoType | undefined;
      if (!is('=')) type = parseType();
      let exprs: GoExpr[] = [];
      if (is('=')) {
        pos += 1;
        exprs = exprList();
      }
      if (!type && exprs.length === 0) fail(`Missing type or init expression for variable '${names[0]}'.`, at);
      names.forEach((name, i) => {
        declare(name, at);
        if (name !== '_') file.vars.set(name, { name, type, expr: exprs.length === names.length ? exprs[i] : undefined, line: at });
      });
      if (group) endSpec(true);
    };
    if (!group) {
      spec();
      return;
    }
    while (!is(')')) {
      if (pos >= tokens.length) fail("Missing ')' to close the var group.");
      if (is(';')) {
        pos += 1;
        continue;
      }
      spec();
    }
    pos += 1;
  };

  const parseFuncDecl = () => {
    // FunctionDecl = "func" FunctionName [ TypeParameters ] Signature [ FunctionBody ].
    // MethodDecl   = "func" Receiver MethodName Signature [ FunctionBody ].
    if (is('(')) parseParameters();
    const name = ident('a function name');
    if (is('[')) pos = closing(pos, 'to close the type parameters') + 1;
    parseSignature(name);
    if (is('{')) pos = closing(pos, 'to close the function body') + 1;
  };

  while (pos < tokens.length) {
    const start = pos;
    try {
      if (is(';')) {
        pos += 1;
        continue;
      }
      if (is('package')) {
        pos += 1;
        file.packageName = ident('a package name');
      } else if (is('import')) {
        pos += 1;
        const one = () => {
          let alias: string | undefined;
          if (isName() || is('.')) {
            alias = peek()!.value;
            pos += 1;
          }
          const pathTok = peek();
          if (pathTok?.kind !== 'str') fail(`Expected an import path but found ${describe(pathTok)}.`);
          pos += 1;
          const path = pathTok!.value.slice(1, -1);
          const name = alias ?? path.split('/').pop()!;
          if (name !== '_' && name !== '.') file.imports.set(name, path);
        };
        if (is('(')) {
          pos += 1;
          while (!is(')')) {
            if (pos >= tokens.length) fail("Missing ')' to close the import group.");
            if (is(';')) {
              pos += 1;
              continue;
            }
            one();
            endSpec(true);
          }
          pos += 1;
        } else {
          one();
        }
      } else if (is('type')) {
        pos += 1;
        if (is('(')) {
          pos += 1;
          while (!is(')')) {
            if (pos >= tokens.length) fail("Missing ')' to close the type group.");
            if (is(';')) {
              pos += 1;
              continue;
            }
            parseTypeSpec();
            endSpec(true);
          }
          pos += 1;
        } else {
          parseTypeSpec();
        }
      } else if (is('const')) {
        pos += 1;
        parseConstDecl();
      } else if (is('var')) {
        pos += 1;
        parseVarDecl();
      } else if (is('func')) {
        pos += 1;
        parseFuncDecl();
      } else {
        fail(`Unexpected ${describe(peek())} at the top level.`);
      }
      if (pos < tokens.length) {
        if (!is(';')) fail(`Expected a new line or ';' after the declaration but found ${describe(peek())}.`);
        pos += 1;
      }
    } catch (err) {
      if (err instanceof NestingError) {
        // Past the limit, what follows is not read, as go/parser bails out at its own.
        file.errors.push({ message: err.message, line: err.line ?? line(), type: 'syntax' });
        break;
      }
      if (!(err instanceof ParseFail)) throw err;
      file.errors.push({ message: err.message, line: err.line, type: 'syntax' });
      pos = Math.max(pos, start + 1);
      skipStatement();
    }
  }

  return file;
}

function splitTopLevel(tokens: GoToken[]): GoToken[][] {
  const out: GoToken[][] = [[]];
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
function splitStatements(tokens: GoToken[]): GoToken[][] {
  const out: GoToken[][] = [[]];
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
function tokensText(tokens: GoToken[]): string {
  const word = (t: GoToken | undefined) => !!t && t.kind !== 'punct';
  const name = (t: GoToken | undefined) => !!t && t.kind === 'id' && !GO_KEYWORDS.has(t.value);
  let out = '';
  tokens.forEach((t, i) => {
    if (t.inserted) return;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const space =
      !!prev &&
      ((word(prev) && word(t)) ||
        prev.value === ',' ||
        (prev.value === ')' && (word(t) || t.value === '(' || t.value === '*' || t.value === '[' || t.value === '<-')) ||
        // `chan<- T`, and `x chan<- T` / `x <-chan T` after a parameter name.
        (prev.value === '<-' && tokens[i - 2]?.value === 'chan') ||
        (name(prev) && t.value === '<-') ||
        // A parameter name before its type: `p *T`, `p []T`, `p [4]T`, `p ...T`, `f func()`.
        (name(prev) && (t.value === '*' || t.value === '...' || (t.value === '[' && (next?.value === ']' || next?.kind === 'int')))));
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
      return `[${formatGoExpr(type.length)}]${formatGoType(type.elem)}`;
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

// gofmt's expression printer (go/printer nodes.go): spaces around binary operators depend on
// the precedences mixed in the expression and on its nesting depth.
const UNARY_PREC = 6;
const HIGHEST_PREC = 7;

function walkBinary(e: Extract<GoExpr, { kind: 'binary' }>): { has4: boolean; has5: boolean; maxProblem: number } {
  const prec = GO_BINARY_PRECEDENCE[e.op];
  let has4 = prec === 4;
  let has5 = prec === 5;
  let maxProblem = 0;
  if (e.x.kind === 'binary' && GO_BINARY_PRECEDENCE[e.x.op] >= prec) {
    const l = walkBinary(e.x);
    has4 ||= l.has4;
    has5 ||= l.has5;
    maxProblem = Math.max(maxProblem, l.maxProblem);
  }
  if (e.y.kind === 'binary') {
    if (GO_BINARY_PRECEDENCE[e.y.op] > prec) {
      const r = walkBinary(e.y);
      has4 ||= r.has4;
      has5 ||= r.has5;
      maxProblem = Math.max(maxProblem, r.maxProblem);
    }
  } else if (e.y.kind === 'star') {
    if (e.op === '/') maxProblem = 5;
  } else if (e.y.kind === 'unary') {
    const pair = e.op + e.y.op;
    if (pair === '/*' || pair === '&&' || pair === '&^') maxProblem = 5;
    else if (pair === '++' || pair === '--') maxProblem = Math.max(maxProblem, 4);
  }
  return { has4, has5, maxProblem };
}

function cutoff(e: Extract<GoExpr, { kind: 'binary' }>, depth: number): number {
  const { has4, has5, maxProblem } = walkBinary(e);
  if (maxProblem > 0) return maxProblem + 1;
  if (has4 && has5) return depth === 1 ? 5 : 4;
  return depth === 1 ? 6 : 4;
}

const diffPrec = (x: GoExpr, prec: number) => (x.kind === 'binary' && GO_BINARY_PRECEDENCE[x.op] === prec ? 0 : 1);
const reduceDepth = (depth: number) => Math.max(1, depth - 1);

/** gofmt's normalizedNumber: lower-case prefixes and exponents. */
function normalizedNumber(x: string): string {
  if (x.length < 2) return x;
  switch (x.slice(0, 2)) {
    case '0X': {
      const s = `0x${x.slice(2)}`;
      const i = s.lastIndexOf('P');
      return i >= 0 ? `${s.slice(0, i)}p${s.slice(i + 1)}` : s;
    }
    case '0x': {
      const i = x.lastIndexOf('P');
      return i >= 0 ? `${x.slice(0, i)}p${x.slice(i + 1)}` : x;
    }
    case '0O':
      return `0o${x.slice(2)}`;
    case '0B':
      return `0b${x.slice(2)}`;
    case '0o': case '0b':
      return x;
    default: {
      const i = x.lastIndexOf('E');
      if (i >= 0) return `${x.slice(0, i)}e${x.slice(i + 1)}`;
      if (x.endsWith('i') && !/[.e]/.test(x)) {
        const t = x.replace(/^[0_]+/, '');
        return t === 'i' ? '0i' : t;
      }
      return x;
    }
  }
}

function expr1(x: GoExpr, prec1: number, depth: number): string {
  switch (x.kind) {
    case 'ident':
      return x.name;
    case 'lit':
      return x.tok === 'int' || x.tok === 'float' || x.tok === 'imag' ? normalizedNumber(x.value) : x.value;
    case 'binary': {
      const prec = GO_BINARY_PRECEDENCE[x.op];
      if (prec < prec1) return `(${expr1(x, 0, reduceDepth(depth))})`;
      const blank = prec < cutoff(x, depth) ? ' ' : '';
      return `${expr1(x.x, prec, depth + diffPrec(x.x, prec))}${blank}${x.op}${blank}${expr1(x.y, prec + 1, depth + 1)}`;
    }
    case 'keyvalue':
      return `${formatGoExpr(x.key)}: ${formatGoExpr(x.value)}`;
    case 'star':
      return UNARY_PREC < prec1 ? `(*${formatGoExpr(x.x)})` : `*${formatGoExpr(x.x)}`;
    case 'unary':
      return UNARY_PREC < prec1 ? `(${formatGoExpr(x)})` : `${x.op}${expr1(x.x, UNARY_PREC, depth)}`;
    case 'paren':
      return x.x.kind === 'paren' ? expr1(x.x, 0, depth) : `(${expr1(x.x, 0, reduceDepth(depth))})`;
    case 'selector':
      return `${expr1(x.x, HIGHEST_PREC, depth)}.${x.sel}`;
    case 'assert':
      return `${expr1(x.x, HIGHEST_PREC, depth)}.(${x.type ? formatGoType(x.type) : 'type'})`;
    case 'index':
      return `${expr1(x.x, HIGHEST_PREC, 1)}[${x.indices.map((i) => expr1(i, 0, depth + 1)).join(', ')}]`;
    case 'slice':
      return `${expr1(x.x, HIGHEST_PREC, 1)}[${x.indices.map((i) => (i ? expr1(i, 0, depth + 1) : '')).join(':')}]`;
    case 'call': {
      const d = x.args.length > 1 ? depth + 1 : depth;
      const paren = (x.fun.kind === 'type' && (x.fun.type.kind === 'func' || (x.fun.type.kind === 'chan' && x.fun.type.dir === 'recv')));
      const fun = expr1(x.fun, HIGHEST_PREC, d);
      return `${paren ? `(${fun})` : fun}(${x.args.map((a) => expr1(a, 0, d)).join(', ')}${x.ellipsis ? '...' : ''})`;
    }
    case 'composite':
      return `${x.type ? expr1(x.type, HIGHEST_PREC, depth) : ''}{${x.elems.map((e) => expr1(e, 0, depth)).join(', ')}}`;
    case 'type':
      return formatGoType(x.type);
    case 'funclit':
      return `${x.type.signature} {...}`;
    case 'ellipsis':
      return '...';
  }
}

/** An expression as gofmt prints it, e.g. an array length `1<<64 - 1`. */
export function formatGoExpr(x: GoExpr): string {
  return expr1(x, 0, 1);
}
