/**
 * Parser for the Rust items that define memory layout: structs (named, tuple, unit), unions,
 * enums, type aliases and constants, with their attributes (#[repr], valid-range attributes)
 * and generics. Everything else (functions, impls, traits, macros, uses) is skipped, and inline
 * modules are flattened.
 *
 * Constant expressions are kept as trees: array lengths and discriminants may use size_of,
 * which depends on the target, so they are evaluated by the layout engine.
 */
import type { ParseError } from '../types';
import { RustLexError, lexRust } from './lexer';
import type { RustToken } from './lexer';

// ------------------------------------------------------------------ AST

export type ConstExpr =
  | { kind: 'lit'; value: bigint; suffix?: string }
  | { kind: 'path'; segments: string[] }
  | { kind: 'unary'; op: '-' | '!'; arg: ConstExpr }
  | { kind: 'binary'; op: string; left: ConstExpr; right: ConstExpr }
  | { kind: 'cast'; arg: ConstExpr; to: string }
  | { kind: 'size_of' | 'align_of'; type: RustType };

export type GenericArg = { kind: 'type'; type: RustType } | { kind: 'const'; expr: ConstExpr };

export type RustType =
  | { kind: 'path'; segments: string[]; args: GenericArg[] }
  | { kind: 'ref'; mutable: boolean; elem: RustType }
  | { kind: 'ptr'; mutable: boolean; elem: RustType }
  | { kind: 'array'; elem: RustType; len: ConstExpr }
  | { kind: 'slice'; elem: RustType }
  | { kind: 'tuple'; elems: RustType[] }
  | { kind: 'fn'; source: string }
  | { kind: 'dyn'; source: string }
  | { kind: 'never' };

export interface RustRepr {
  c: boolean;
  transparent: boolean;
  /** repr(u8), repr(i32), ...: the discriminant type of an enum. */
  int?: string;
  packed?: number;
  align?: number;
}

export interface RustField {
  /** Field name; "0", "1", ... for tuple fields. */
  name: string;
  type: RustType;
  line: number;
}

export interface RustVariant {
  name: string;
  fields: RustField[];
  /** `Variant(A, B)`. */
  tuple: boolean;
  discriminant?: ConstExpr;
  line: number;
}

export type GenericParam =
  | { kind: 'type'; name: string; default?: RustType; /** Bounded by ?Sized. */ maybeUnsized?: boolean }
  | { kind: 'const'; name: string; default?: ConstExpr };

interface ItemBase {
  name: string;
  generics: GenericParam[];
  line: number;
}

export interface RustStruct extends ItemBase {
  kind: 'struct' | 'union';
  repr: RustRepr;
  fields: RustField[];
  /** `struct S(A, B);` or `struct S;`. */
  shape: 'named' | 'tuple' | 'unit';
  /** #[rustc_layout_scalar_valid_range_start/end]: narrows the valid range of the first scalar. */
  validRange?: { start?: ConstExpr; end?: ConstExpr };
  /** #[lang = "unsafe_cell"]: hides niches. */
  unsafeCell?: boolean;
}

export interface RustEnum extends ItemBase {
  kind: 'enum';
  repr: RustRepr;
  variants: RustVariant[];
}

export interface RustAlias extends ItemBase {
  kind: 'alias';
  type: RustType;
}

export type RustItem = RustStruct | RustEnum | RustAlias;

export interface RustConst {
  type?: RustType;
  expr: ConstExpr;
  line: number;
}

export interface RustFile {
  items: Map<string, RustItem>;
  /** Item names in source order. */
  order: string[];
  consts: Map<string, RustConst>;
  errors: ParseError[];
  warnings: ParseError[];
}

class Recover extends Error {}

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern',
  'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub',
  'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use',
  'where', 'while',
]);

export const INTEGER_TYPES = ['u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize'];

// ------------------------------------------------------------------ parser

export function parseRust(code: string): RustFile {
  const file: RustFile = { items: new Map(), order: [], consts: new Map(), errors: [], warnings: [] };
  let tokens: RustToken[];
  try {
    tokens = lexRust(code);
  } catch (err) {
    if (!(err instanceof RustLexError)) throw err;
    file.errors.push({ message: err.message, line: err.line, type: 'syntax' });
    return file;
  }
  let pos = 0;

  const peek = (o = 0): RustToken | undefined => tokens[pos + o];
  const is = (v: string, o = 0) => {
    const t = tokens[pos + o];
    return !!t && (t.kind === 'punct' || t.kind === 'id') && t.value === v && !t.lifetime;
  };
  const line = () => (peek() ?? tokens[tokens.length - 1])?.line ?? 1;
  const fail = (message: string, at = line()): never => {
    file.errors.push({ message, line: at, type: 'syntax' });
    throw new Recover();
  };
  const found = () => (peek() ? ` but found '${peek()!.value}'` : ' but the input ended');
  const expect = (v: string, what: string) => {
    if (!is(v)) fail(`Expected '${v}' ${what}${found()}.`);
    pos += 1;
  };
  const ident = (what: string): string => {
    const t = peek();
    if (t?.kind !== 'id' || t.lifetime || KEYWORDS.has(t.value)) fail(`Expected ${what}${found()}.`);
    pos += 1;
    return t!.value;
  };
  /** Closing '>' of a generic list, splitting '>>', '>=' and '>>=' as needed. */
  const closeAngle = () => {
    const t = peek();
    if (!t || t.kind !== 'punct' || !t.value.startsWith('>')) fail(`Expected '>'${found()}.`);
    if (t!.value === '>') pos += 1;
    else tokens[pos] = { ...t!, value: t!.value.slice(1) };
  };
  const isCloseAngle = () => {
    const t = peek();
    return !!t && t.kind === 'punct' && t.value.startsWith('>') && t.value !== '>=' ;
  };
  /** Index of the token closing the bracket at `start`, counting (), [], {} only. */
  const closing = (start: number): number => {
    const open = tokens[start]!.value;
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    let depth = 0;
    for (let i = start; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.kind !== 'punct') continue;
      if (t.value === open) depth += 1;
      else if (t.value === close && --depth === 0) return i;
    }
    return fail(`Missing '${close}'.`, tokens[start]!.line);
  };
  const skipGroup = () => {
    pos = closing(pos) + 1;
  };

  // ---------------------------------------------------------------- constant expressions

  const PRECEDENCE: Record<string, number> = {
    '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 3, '>': 3, '<=': 3, '>=': 3,
    '|': 4, '^': 5, '&': 6, '<<': 7, '>>': 7, '+': 8, '-': 8, '*': 9, '/': 9, '%': 9,
  };

  const parseExpr = (minPrec = 1): ConstExpr => {
    let left = parseCast();
    for (;;) {
      const t = peek();
      const prec = t?.kind === 'punct' ? PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      pos += 1;
      const right = parseExpr(prec + 1);
      left = { kind: 'binary', op: t!.value, left, right };
    }
  };

  const parseCast = (): ConstExpr => {
    let e = parseUnary();
    while (is('as')) {
      pos += 1;
      const to = ident('a type after `as`');
      e = { kind: 'cast', arg: e, to };
    }
    return e;
  };

  const parseUnary = (): ConstExpr => {
    if (is('-')) {
      pos += 1;
      return { kind: 'unary', op: '-', arg: parseUnary() };
    }
    if (is('!')) {
      pos += 1;
      return { kind: 'unary', op: '!', arg: parseUnary() };
    }
    return parsePrimary();
  };

  const parsePrimary = (): ConstExpr => {
    const t = peek();
    if (!t) return fail('Expected an expression but the input ended.');
    if (t.kind === 'num') {
      pos += 1;
      if (/[.eE]/.test(t.value) && !/^0x/i.test(t.value)) fail(`'${t.value}' is not an integer.`, t.line);
      // Rust has no octal-by-leading-zero: 0755 is decimal.
      const text = t.value.replace(/_/g, '');
      const value = /^0[0-9]+$/.test(text) ? BigInt(text.replace(/^0+/, '') || '0') : BigInt(text.replace(/^0o/i, '0o'));
      return { kind: 'lit', value, suffix: t.suffix };
    }
    if (t.kind === 'char') {
      pos += 1;
      return { kind: 'lit', value: BigInt(charValue(t.value, t.line)) };
    }
    if (is('(')) {
      pos += 1;
      const e = parseExpr();
      expect(')', 'to close the expression');
      return e;
    }
    if (is('{')) {
      pos += 1;
      const e = parseExpr();
      expect('}', 'to close the block');
      return e;
    }
    if (t.kind === 'id' && (t.value === 'true' || t.value === 'false')) {
      pos += 1;
      return { kind: 'lit', value: t.value === 'true' ? 1n : 0n };
    }
    if (t.kind === 'id' || is('::')) {
      const segments: string[] = [];
      if (is('::')) pos += 1;
      segments.push(ident('a name'));
      let typeArg: RustType | undefined;
      while (is('::')) {
        pos += 1;
        if (is('<')) {
          pos += 1;
          typeArg = parseType();
          closeAngle();
          break;
        }
        segments.push(ident('a name'));
      }
      const last = segments[segments.length - 1]!;
      if (is('(')) {
        if ((last === 'size_of' || last === 'align_of') && typeArg) {
          pos += 1;
          expect(')', `after ${last}::<T>(`);
          return { kind: last, type: typeArg };
        }
        fail(`Function calls other than size_of::<T>() and align_of::<T>() are not supported in constants.`, t.line);
      }
      if (is('.')) fail('Method calls are not supported in constants.', t.line);
      return { kind: 'path', segments };
    }
    return fail(`Expected an expression but found '${t.value}'.`, t.line);
  };

  // ---------------------------------------------------------------- types

  /** Tokens of a bound or trait object, up to the end of the type. */
  const skipBounds = (): string => {
    const start = pos;
    let depth = 0;
    while (pos < tokens.length) {
      const t = peek()!;
      if (t.kind === 'punct') {
        if (t.value === '(' || t.value === '[') depth += 1;
        else if (t.value === '<') depth += 1;
        else if (t.value === ')' || t.value === ']') {
          if (depth === 0) break;
          depth -= 1;
        } else if (t.value.startsWith('>') && t.value !== '>=') {
          if (depth === 0) break;
          // '>>' closes two levels; leave the rest for the caller.
          if (t.value === '>>' && depth === 1) {
            tokens[pos] = { ...t, value: '>' };
            depth -= 1;
            break;
          }
          depth -= t.value === '>>' ? 2 : 1;
        } else if (depth === 0 && [',', ';', '=', '{', '}'].includes(t.value)) break;
      }
      pos += 1;
    }
    return tokens
      .slice(start, pos)
      .map((t) => t.value)
      .join(' ')
      .replace(/ ?(::|<|>|\(|\)) ?/g, '$1')
      .replace(/,/g, ', ')
      .replace(/->/g, ' -> ');
  };

  const parseGenericArgs = (): GenericArg[] => {
    // After '<'.
    const args: GenericArg[] = [];
    while (!isCloseAngle()) {
      const t = peek();
      if (!t) fail("Missing '>'.");
      if (t!.lifetime) {
        pos += 1;
      } else if (t!.kind === 'num' || t!.kind === 'char' || is('{') || is('-') || is('true') || is('false')) {
        args.push({ kind: 'const', expr: parsePrimaryOrNeg() });
      } else if (t!.kind === 'id' && is('=', 1)) {
        // Associated type binding (Iterator<Item = u8>): no layout meaning.
        pos += 2;
        parseType();
      } else {
        args.push({ kind: 'type', type: parseType() });
      }
      if (is(',')) pos += 1;
      else if (!isCloseAngle()) fail(`Expected ',' or '>' in generic arguments${found()}.`);
    }
    closeAngle();
    return args;
  };

  const parsePrimaryOrNeg = (): ConstExpr => (is('-') ? parseUnary() : parsePrimary());

  const parseType = (): RustType => {
    const t = peek();
    if (!t) return fail('Expected a type but the input ended.');
    if (t.lifetime) fail(`Expected a type but found the lifetime '${t.value}'.`);
    if (is('(')) {
      pos += 1;
      const elems: RustType[] = [];
      let trailingComma = false;
      while (!is(')')) {
        elems.push(parseType());
        trailingComma = false;
        if (is(',')) {
          pos += 1;
          trailingComma = true;
        } else if (!is(')')) fail(`Expected ',' or ')' in tuple type${found()}.`);
      }
      pos += 1;
      return elems.length === 1 && !trailingComma ? elems[0]! : { kind: 'tuple', elems };
    }
    if (is('[')) {
      pos += 1;
      const elem = parseType();
      if (is(';')) {
        pos += 1;
        const len = parseExpr();
        expect(']', 'to close the array type');
        return { kind: 'array', elem, len };
      }
      expect(']', 'to close the slice type');
      return { kind: 'slice', elem };
    }
    if (is('&') || is('&&')) {
      const double = is('&&');
      pos += 1;
      if (peek()?.lifetime) pos += 1;
      const mutable = is('mut');
      if (mutable) pos += 1;
      const inner: RustType = { kind: 'ref', mutable, elem: parseType() };
      return double ? { kind: 'ref', mutable: false, elem: inner } : inner;
    }
    if (is('*')) {
      pos += 1;
      if (!is('const') && !is('mut')) fail("Expected 'const' or 'mut' after '*' in a raw pointer type.");
      const mutable = is('mut');
      pos += 1;
      return { kind: 'ptr', mutable, elem: parseType() };
    }
    if (is('!')) {
      pos += 1;
      return { kind: 'never' };
    }
    if (is('fn') || is('unsafe') || is('extern') || is('for')) {
      const start = pos;
      if (is('for')) {
        pos += 1;
        if (!is('<')) fail("Expected '<' after 'for'.");
        pos += 1;
        parseGenericArgs();
      }
      if (is('unsafe')) pos += 1;
      if (is('extern')) {
        pos += 1;
        if (peek()?.kind === 'str') pos += 1;
      }
      if (!is('fn')) {
        // `for<'a> dyn Trait` and friends: treat as a trait object.
        pos = start;
        return { kind: 'dyn', source: skipBounds() };
      }
      pos += 1;
      if (!is('(')) fail("Expected '(' after 'fn'.");
      skipGroup();
      if (is('->')) {
        pos += 1;
        parseType();
      }
      return { kind: 'fn', source: tokensText(tokens.slice(start, pos)) };
    }
    if (is('dyn') || is('impl')) {
      return { kind: 'dyn', source: skipBounds() };
    }
    if (is('_')) fail("The placeholder type '_' is not allowed here.");
    if (is('<')) fail('Qualified paths (<T as Trait>::Type) are not supported.');
    if (t.kind === 'id' || is('::')) {
      const segments: string[] = [];
      if (is('::')) pos += 1;
      let args: GenericArg[] = [];
      for (;;) {
        const seg = peek();
        if (seg?.kind !== 'id' || seg.lifetime) fail(`Expected a type name${found()}.`);
        pos += 1;
        segments.push(seg!.value);
        args = [];
        if (is('::') && is('<', 1)) pos += 1; // turbofish in type position
        if (is('<')) {
          pos += 1;
          args = parseGenericArgs();
        } else if (is('(') && /^(Fn|FnMut|FnOnce)$/.test(seg!.value)) {
          // Fn(A) -> B sugar, only meaningful inside dyn/impl.
          skipGroup();
          if (is('->')) {
            pos += 1;
            parseType();
          }
        }
        if (is('::') && peek(1)?.kind === 'id') {
          pos += 1;
          continue;
        }
        break;
      }
      return { kind: 'path', segments, args };
    }
    return fail(`Expected a type but found '${t.value}'.`);
  };

  // ---------------------------------------------------------------- attributes

  interface Attrs {
    repr: RustRepr;
    validStart?: ConstExpr;
    validEnd?: ConstExpr;
    unsafeCell: boolean;
    cfg: boolean;
  }

  const parseAttributes = (): Attrs => {
    const attrs: Attrs = { repr: { c: false, transparent: false }, unsafeCell: false, cfg: false };
    while (is('#') && (is('[', 1) || (is('!', 1) && is('[', 2)))) {
      const inner = is('!', 1);
      pos += inner ? 2 : 1;
      const close = closing(pos);
      pos += 1;
      const name = peek()?.value;
      if (name === 'repr' && is('(', 1)) {
        pos += 2;
        while (!is(')')) {
          const at = line();
          const r = ident('a repr hint');
          if (r === 'C') attrs.repr.c = true;
          else if (r === 'Rust') {
            // The default.
          } else if (r === 'transparent') attrs.repr.transparent = true;
          else if (r === 'packed' || r === 'align') {
            let n = r === 'packed' ? 1 : 0;
            if (is('(')) {
              pos += 1;
              const v = peek();
              if (v?.kind !== 'num') fail(`Expected a number in repr(${r}(...)).`);
              n = Number(BigInt(v!.value.replace(/_/g, '')));
              pos += 1;
              expect(')', `to close repr(${r}(...))`);
            } else if (r === 'align') fail('repr(align) needs a value, e.g. repr(align(8)).', at);
            if (n <= 0 || (n & (n - 1)) !== 0) fail(`repr(${r}(${n})): the value must be a power of two.`, at);
            if (r === 'packed') attrs.repr.packed = n;
            else attrs.repr.align = Math.max(attrs.repr.align ?? 1, n);
          } else if (INTEGER_TYPES.includes(r)) attrs.repr.int = r;
          else if (r === 'simd') fail('repr(simd) is not supported.', at);
          else fail(`Unknown repr hint '${r}'.`, at);
          if (is(',')) pos += 1;
          else if (!is(')')) fail(`Expected ',' or ')' in repr(...)${found()}.`);
        }
        pos += 1;
      } else if ((name === 'rustc_layout_scalar_valid_range_start' || name === 'rustc_layout_scalar_valid_range_end') && is('(', 1)) {
        pos += 2;
        const e = parseExpr();
        expect(')', `to close ${name}(...)`);
        if (name.endsWith('start')) attrs.validStart = e;
        else attrs.validEnd = e;
      } else if (name === 'lang' && peek(2)?.value === '"unsafe_cell"') {
        attrs.unsafeCell = true;
      } else if (name === 'cfg' || name === 'cfg_attr') {
        attrs.cfg = true;
      }
      pos = close + 1;
    }
    return attrs;
  };

  const skipVisibility = () => {
    if (is('pub')) {
      pos += 1;
      if (is('(')) skipGroup();
    }
  };

  // ---------------------------------------------------------------- items

  const parseGenericParams = (): GenericParam[] => {
    const params: GenericParam[] = [];
    if (!is('<')) return params;
    pos += 1;
    while (!isCloseAngle()) {
      parseAttributes();
      const t = peek();
      if (!t) fail("Missing '>' after generic parameters.");
      if (t!.lifetime) {
        pos += 1;
        if (is(':')) {
          pos += 1;
          skipBounds();
        }
      } else if (is('const')) {
        pos += 1;
        const name = ident('a const parameter name');
        expect(':', 'after the const parameter name');
        parseType();
        let def: ConstExpr | undefined;
        if (is('=')) {
          pos += 1;
          def = parsePrimaryOrNeg();
        }
        params.push({ kind: 'const', name, default: def });
      } else {
        const name = ident('a type parameter name');
        let maybeUnsized = false;
        if (is(':')) {
          pos += 1;
          maybeUnsized = /\?\s*Sized\b/.test(skipBounds());
        }
        let def: RustType | undefined;
        if (is('=')) {
          pos += 1;
          def = parseType();
        }
        params.push({ kind: 'type', name, default: def, maybeUnsized });
      }
      if (is(',')) pos += 1;
      else if (!isCloseAngle()) fail(`Expected ',' or '>' in generic parameters${found()}.`);
    }
    closeAngle();
    return params;
  };

  /** Skip a where clause, marking parameters it bounds by ?Sized. */
  const skipWhere = (generics: GenericParam[]) => {
    if (!is('where')) return;
    pos += 1;
    while (pos < tokens.length && !is('{') && !is(';')) {
      if (peek()?.kind === 'id' && is(':', 1)) {
        const name = peek()!.value;
        pos += 2;
        if (/\?\s*Sized\b/.test(skipBounds())) {
          const p = generics.find((g) => g.kind === 'type' && g.name === name);
          if (p?.kind === 'type') p.maybeUnsized = true;
        }
      } else if (is('(') || is('[')) skipGroup();
      else pos += 1;
    }
  };

  const fieldWarning = (attrs: Attrs, at: number) => {
    if (attrs.cfg) {
      file.warnings.push({ message: 'cfg attributes are not evaluated: the field or item is always included.', line: at, type: 'warning' });
    }
  };

  const parseNamedFields = (): RustField[] => {
    expect('{', 'to start the fields');
    const fields: RustField[] = [];
    while (!is('}')) {
      const at = line();
      fieldWarning(parseAttributes(), at);
      skipVisibility();
      const name = ident('a field name');
      expect(':', `after field '${name}'`);
      fields.push({ name, type: parseType(), line: at });
      if (is(',')) pos += 1;
      else if (!is('}')) fail(`Expected ',' or '}' after field '${name}'${found()}.`);
    }
    pos += 1;
    return fields;
  };

  const parseTupleFields = (): RustField[] => {
    expect('(', 'to start the fields');
    const fields: RustField[] = [];
    while (!is(')')) {
      const at = line();
      fieldWarning(parseAttributes(), at);
      skipVisibility();
      fields.push({ name: String(fields.length), type: parseType(), line: at });
      if (is(',')) pos += 1;
      else if (!is(')')) fail(`Expected ',' or ')' between tuple fields${found()}.`);
    }
    pos += 1;
    return fields;
  };

  const register = (item: RustItem) => {
    if (file.items.has(item.name)) {
      file.errors.push({ message: `'${item.name}' is defined more than once.`, line: item.line, type: 'semantic' });
    }
    file.items.set(item.name, item);
    file.order.push(item.name);
  };

  const parseStruct = (attrs: Attrs, kind: 'struct' | 'union', at: number) => {
    const name = ident(`a ${kind} name`);
    const generics = parseGenericParams();
    skipWhere(generics);
    let fields: RustField[];
    let shape: RustStruct['shape'];
    if (is('{')) {
      fields = parseNamedFields();
      shape = 'named';
    } else if (kind === 'struct' && is('(')) {
      fields = parseTupleFields();
      shape = 'tuple';
      skipWhere(generics);
      expect(';', `after tuple struct '${name}'`);
    } else if (kind === 'struct' && is(';')) {
      pos += 1;
      fields = [];
      shape = 'unit';
    } else {
      return fail(`Expected '{'${kind === 'struct' ? ", '(' or ';'" : ''} after ${kind} '${name}'${found()}.`);
    }
    if (kind === 'union' && fields.length === 0) fail(`Union '${name}' needs at least one field.`, at);
    const validRange = attrs.validStart || attrs.validEnd ? { start: attrs.validStart, end: attrs.validEnd } : undefined;
    register({ kind, name, generics, repr: attrs.repr, fields, shape, validRange, unsafeCell: attrs.unsafeCell, line: at });
  };

  const parseEnum = (attrs: Attrs, at: number) => {
    const name = ident('an enum name');
    const generics = parseGenericParams();
    skipWhere(generics);
    expect('{', `after enum '${name}'`);
    const variants: RustVariant[] = [];
    while (!is('}')) {
      const vat = line();
      fieldWarning(parseAttributes(), vat);
      skipVisibility();
      const vname = ident('a variant name');
      let fields: RustField[] = [];
      let tuple = false;
      if (is('{')) fields = parseNamedFields();
      else if (is('(')) {
        fields = parseTupleFields();
        tuple = true;
      }
      let discriminant: ConstExpr | undefined;
      if (is('=')) {
        pos += 1;
        discriminant = parseExpr();
      }
      variants.push({ name: vname, fields, tuple, discriminant, line: vat });
      if (is(',')) pos += 1;
      else if (!is('}')) fail(`Expected ',' or '}' after variant '${vname}'${found()}.`);
    }
    pos += 1;
    register({ kind: 'enum', name, generics, repr: attrs.repr, variants, line: at });
  };

  /** Skip an item we do not model: up to its ';' or past its body. */
  const skipItem = () => {
    while (pos < tokens.length) {
      if (is(';')) {
        pos += 1;
        return;
      }
      if (is('{')) {
        skipGroup();
        // `impl X {}` and `fn f() {}` end at the block; `const X: T = T { .. };` continues.
        if (is(';')) pos += 1;
        return;
      }
      if (is('(') || is('[')) skipGroup();
      else pos += 1;
    }
  };

  const parseItems = (endAtBrace: boolean) => {
    while (pos < tokens.length && !(endAtBrace && is('}'))) {
      const start = pos;
      try {
        const at = line();
        const attrs = parseAttributes();
        if (pos >= tokens.length || (endAtBrace && is('}'))) break;
        skipVisibility();
        if (is('struct')) {
          pos += 1;
          parseStruct(attrs, 'struct', at);
        } else if (is('union') && peek(1)?.kind === 'id') {
          pos += 1;
          parseStruct(attrs, 'union', at);
        } else if (is('enum')) {
          pos += 1;
          parseEnum(attrs, at);
        } else if (is('type')) {
          pos += 1;
          const name = ident('a type alias name');
          const generics = parseGenericParams();
          skipWhere(generics);
          expect('=', `after type alias '${name}'`);
          const type = parseType();
          expect(';', `after type alias '${name}'`);
          register({ kind: 'alias', name, generics, type, line: at });
        } else if (is('const') && !is('fn', 1) && !is('unsafe', 1) && !is('extern', 1) && !is('async', 1)) {
          pos += 1;
          if (is('_')) {
            skipItem();
          } else {
            const name = ident('a constant name');
            let type: RustType | undefined;
            if (is(':')) {
              pos += 1;
              type = parseType();
            }
            expect('=', `in constant '${name}'`);
            const exprStart = pos;
            const errorCount = file.errors.length;
            try {
              const expr = parseExpr();
              if (!is(';')) throw new Recover();
              pos += 1;
              file.consts.set(name, { type, expr, line: at });
            } catch (err) {
              if (!(err instanceof Recover)) throw err;
              // A constant that is not an integer expression (a string, a struct value) is
              // fine unless something uses it, which then reports it as unknown.
              file.errors.length = errorCount;
              pos = exprStart;
              skipItem();
            }
          }
        } else if (is('mod') && peek(1)?.kind === 'id' && is('{', 2)) {
          pos += 3;
          parseItems(true);
          expect('}', 'to close the module');
        } else if (peek()?.kind === 'id' && is('!', 1) && !is('[', 2)) {
          // Macro invocation or macro_rules! definition.
          pos += 2;
          if (peek()?.kind === 'id') pos += 1;
          if (is('{') || is('(') || is('[')) skipGroup();
          if (is(';')) pos += 1;
        } else if (
          ['fn', 'impl', 'trait', 'use', 'extern', 'static', 'unsafe', 'async', 'mod', 'const', 'auto'].includes(peek()?.value ?? '')
        ) {
          skipItem();
        } else {
          fail(`Unexpected '${peek()!.value}' at the top level.`);
        }
      } catch (err) {
        if (!(err instanceof Recover)) throw err;
        pos = Math.max(pos, start + 1);
        // Resynchronise at the next item keyword.
        while (pos < tokens.length && !['struct', 'enum', 'union', 'type', 'const', 'fn', 'impl', 'mod', 'use', 'pub', '#'].includes(peek()!.value)) {
          pos += 1;
        }
      }
      if (pos === start) pos += 1;
    }
  };

  parseItems(false);
  return file;
}

function charValue(literal: string, line: number): number {
  const body = literal.replace(/^b?'/, '').replace(/'$/, '');
  if (!body.startsWith('\\')) return body.codePointAt(0)!;
  const esc: Record<string, number> = { n: 10, r: 13, t: 9, '\\': 92, '0': 0, "'": 39, '"': 34 };
  if (body.length === 2 && body[1]! in esc) return esc[body[1]!]!;
  const hex = /^\\x([0-9a-fA-F]{2})$/.exec(body);
  if (hex) return parseInt(hex[1]!, 16);
  const uni = /^\\u\{([0-9a-fA-F_]+)\}$/.exec(body);
  if (uni) return parseInt(uni[1]!.replace(/_/g, ''), 16);
  throw new RustLexError(`Unsupported character literal ${literal}.`, line);
}

function tokensText(tokens: readonly RustToken[]): string {
  let out = '';
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    const tight =
      !prev ||
      ['(', ')', ',', '::', '<', '>', '[', ']', ';'].includes(t.value) ||
      ['(', '::', '<', '[', '&', '*'].includes(prev.value);
    out += (tight && !(prev?.value === ',') ? '' : ' ') + t.value;
  });
  return out.replace(/->/g, ' -> ').replace(/\s+/g, ' ').replace(/ -> /g, ' -> ').trim();
}

/** Canonical Rust source text for a type. */
export function formatRustType(type: RustType): string {
  switch (type.kind) {
    case 'path': {
      const args = type.args.map((a) => (a.kind === 'type' ? formatRustType(a.type) : formatConstExpr(a.expr)));
      return `${type.segments.join('::')}${args.length ? `<${args.join(', ')}>` : ''}`;
    }
    case 'ref':
      return `&${type.mutable ? 'mut ' : ''}${formatRustType(type.elem)}`;
    case 'ptr':
      return `*${type.mutable ? 'mut' : 'const'} ${formatRustType(type.elem)}`;
    case 'array':
      return `[${formatRustType(type.elem)}; ${formatConstExpr(type.len)}]`;
    case 'slice':
      return `[${formatRustType(type.elem)}]`;
    case 'tuple':
      return type.elems.length === 1 ? `(${formatRustType(type.elems[0]!)},)` : `(${type.elems.map(formatRustType).join(', ')})`;
    case 'fn':
    case 'dyn':
      return type.source;
    case 'never':
      return '!';
  }
}

export function formatConstExpr(e: ConstExpr): string {
  switch (e.kind) {
    case 'lit':
      return `${e.value}${e.suffix ?? ''}`;
    case 'path':
      return e.segments.join('::');
    case 'unary':
      return `${e.op}${formatConstExpr(e.arg)}`;
    case 'binary':
      return `${formatConstExpr(e.left)} ${e.op} ${formatConstExpr(e.right)}`;
    case 'cast':
      return `${formatConstExpr(e.arg)} as ${e.to}`;
    case 'size_of':
    case 'align_of':
      return `${e.kind}::<${formatRustType(e.type)}>()`;
  }
}
