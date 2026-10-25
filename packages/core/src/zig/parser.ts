/**
 * Zig parser for what decides a type's layout: container-level declarations (`const`, `var`,
 * functions), container types (struct, union, enum, opaque, with extern/packed and their
 * arguments), type expressions (pointers, slices, arrays with sentinels, optionals, error sets and
 * unions, function types), and the comptime expressions they use: integer arithmetic, builtins,
 * calls of type-returning functions and `if`. Function bodies are kept only for functions that
 * may return a type: their `const` declarations, `return` and `if` statements.
 *
 * It follows the grammar in the Zig language reference (TypeExpr, ErrorUnionExpr, SuffixExpr,
 * ContainerDecl), so what it accepts parses as Zig does.
 */
import { ZigLexError, lexZig } from './lexer';
import type { ZigToken } from './lexer';
import type { ParseError } from '../types';

export type Expr =
  | { k: 'ident'; name: string; line: number }
  | { k: 'int'; v: bigint; line: number }
  | { k: 'float'; text: string; line: number }
  | { k: 'string'; v: string; line: number }
  | { k: 'enumLit'; name: string; line: number }
  /** `.{ ... }`, `T{ ... }`: not evaluated, only skipped. */
  | { k: 'init'; type?: Expr; line: number }
  | { k: 'errorSet'; names: string[]; line: number }
  | { k: 'errorValue'; name: string; line: number }
  | { k: 'field'; obj: Expr; name: string; line: number }
  | { k: 'call'; fn: Expr; args: Expr[]; line: number }
  | { k: 'builtin'; name: string; args: Expr[]; line: number }
  | { k: 'unary'; op: string; e: Expr; line: number }
  | { k: 'binary'; op: string; l: Expr; r: Expr; line: number }
  | { k: 'index'; obj: Expr; index: Expr; line: number }
  | { k: 'deref' | 'unwrap'; e: Expr; line: number }
  | { k: 'optional'; child: Expr; line: number }
  | { k: 'errorUnion'; set: Expr; payload: Expr; line: number }
  | {
      k: 'pointer';
      size: 'one' | 'many' | 'slice' | 'c';
      sentinel?: Expr;
      align?: Expr;
      isConst: boolean;
      isVolatile: boolean;
      allowzero: boolean;
      child: Expr;
      line: number;
    }
  | { k: 'array'; len: Expr | 'infer'; sentinel?: Expr; child: Expr; line: number }
  | { k: 'container'; c: ContainerDecl; line: number }
  | { k: 'fnType'; params: Param[]; ret: Expr; callconv?: Expr; line: number }
  /** `if (c) a else b`; with `|x|`, c is an optional and x its payload. */
  | { k: 'if'; cond: Expr; capture?: string; then: Expr; else?: Expr; line: number }
  | { k: 'comptime'; e: Expr; line: number }
  /** Reaching it at compile time is a compile error. */
  | { k: 'unreachable'; line: number }
  /** `switch (x) { a, b => e, 1...3 => f, else => g }`, without captures. */
  | { k: 'switch'; subject: Expr; prongs: SwitchProng[]; line: number };

export interface SwitchProng {
  /** Values and ranges (`a...b`); empty for `else`. */
  items: Array<{ value: Expr } | { from: Expr; to: Expr }>;
  isElse: boolean;
  body: Expr;
}

export interface Param {
  name?: string;
  comptime: boolean;
  /** `anytype` is undefined. */
  type?: Expr;
}

export type Stmt =
  | { k: 'decl'; decl: Decl }
  | { k: 'return'; e?: Expr; line: number }
  | { k: 'if'; cond: Expr; capture?: string; then: Stmt; else?: Stmt; line: number }
  | { k: 'block'; body: Stmt[] }
  /** `x = e;` and the compound forms: only constants decide a type, so running one is an error. */
  | { k: 'assign'; target: Expr; value: Expr; line: number }
  | { k: 'expr'; e: Expr; line: number };

export interface FnDecl {
  params: Param[];
  /** The return type; with `inferredErrorSet`, the payload of `!T`. */
  ret: Expr;
  callconv?: Expr;
  /** `fn f() !T`: the error set is inferred from the body. */
  inferredErrorSet?: boolean;
  /** null for `extern fn` prototypes. */
  body: Stmt[] | null;
  /** The body uses statements the evaluator does not run (loops, switches, assignments). */
  unsupported?: string;
}

export interface Decl {
  name: string;
  pub: boolean;
  kind: 'const' | 'var' | 'fn';
  type?: Expr;
  value?: Expr;
  fn?: FnDecl;
  line: number;
  /** Source offsets of the whole declaration. */
  start: number;
  end: number;
}

export interface FieldDecl {
  /** Tuple fields have none. */
  name?: string;
  type?: Expr;
  align?: Expr;
  /** Default value of a struct field, or the value of an enum field. */
  value?: Expr;
  comptime: boolean;
  line: number;
  /** Source offsets of the type as written. */
  typeStart?: number;
  typeEnd?: number;
  /** Source offsets of the field without its trailing comma. */
  start: number;
  end: number;
}

export interface ContainerDecl {
  kind: 'struct' | 'union' | 'enum' | 'opaque';
  layout: 'auto' | 'extern' | 'packed';
  /** `packed struct(u32)`, `enum(u8)`, `union(Tag)`. */
  arg?: Expr;
  /** `union(enum)`, `union(enum(u8))`. */
  unionEnum?: boolean;
  unionEnumArg?: Expr;
  fields: FieldDecl[];
  decls: Decl[];
  /** An enum with a `_` field. */
  nonexhaustive: boolean;
  line: number;
  /** Offsets of the container keyword through the closing brace. */
  start: number;
  end: number;
  /** Offsets of the body's braces. */
  bodyStart: number;
  bodyEnd: number;
}

export interface ZigFile {
  /** The file is a struct: its top-level declarations and fields. */
  root: ContainerDecl;
  source: string;
  errors: ParseError[];
  warnings: ParseError[];
}

export class ZigParseError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(message);
  }
}

const KEYWORDS = new Set([
  'addrspace', 'align', 'allowzero', 'and', 'anyframe', 'anytype', 'asm', 'break', 'callconv', 'catch', 'comptime',
  'const', 'continue', 'defer', 'else', 'enum', 'errdefer', 'error', 'export', 'extern', 'fn', 'for', 'if', 'inline',
  'noalias', 'nosuspend', 'noinline', 'opaque', 'or', 'orelse', 'packed', 'pub', 'resume', 'return', 'linksection',
  'struct', 'suspend', 'switch', 'test', 'threadlocal', 'try', 'union', 'unreachable', 'var', 'volatile', 'while',
]);

/** Binary operators by precedence, lowest first (the Zig grammar's expression levels). */
const BINARY_LEVELS: readonly (readonly string[])[] = [
  ['or'],
  ['and'],
  ['==', '!=', '<', '>', '<=', '>='],
  ['&', '^', '|', 'orelse', 'catch'],
  ['<<', '>>', '<<|'],
  ['+', '-', '++', '+%', '-%', '+|', '-|'],
  ['||', '*', '/', '%', '**', '*%', '*|'],
];

class Parser {
  private pos = 0;
  readonly warnings: ParseError[] = [];

  constructor(
    private readonly tokens: ZigToken[],
    private readonly source: string,
  ) {}

  private peek(offset = 0): ZigToken {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): ZigToken {
    const t = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return t;
  }

  private is(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    // A quoted identifier (@"fn") is a name, not the keyword or punctuation it spells.
    return (t.kind === 'punct' || (t.kind === 'ident' && !t.quoted)) && t.text === text;
  }

  private accept(text: string): boolean {
    if (this.is(text)) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(text: string): ZigToken {
    const t = this.peek();
    if (!this.is(text)) {
      throw new ZigParseError(`Expected '${text}', found ${t.kind === 'eof' ? 'end of input' : `'${t.text}'`}.`, t.line);
    }
    return this.next();
  }

  private identifier(): ZigToken {
    const t = this.peek();
    if (t.kind !== 'ident' || (KEYWORDS.has(t.text) && !t.quoted)) {
      throw new ZigParseError(`Expected a name, found ${t.kind === 'eof' ? 'end of input' : `'${t.text}'`}.`, t.line);
    }
    return this.next();
  }

  /** Skip a balanced group starting at an opening bracket. */
  private skipGroup(): void {
    const open = this.next();
    const close = open.text === '(' ? ')' : open.text === '[' ? ']' : '}';
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === 'eof') throw new ZigParseError(`Unbalanced '${open.text}'.`, open.line);
      if (t.kind !== 'punct') continue;
      if (t.text === open.text) depth += 1;
      else if (t.text === close) depth -= 1;
    }
  }

  // ------------------------------------------------------------------ containers

  /** The members of a container body (or of the file), up to `}` or the end of input. */
  containerMembers(c: ContainerDecl, closing: string): void {
    while (!this.is(closing) && this.peek().kind !== 'eof') {
      const t = this.peek();
      if (this.is('test')) {
        this.next();
        if (this.peek().kind === 'string' || this.peek().kind === 'ident') this.next();
        this.skipGroup();
        continue;
      }
      if (this.is('comptime') && this.is('{', 1)) {
        this.next();
        this.skipGroup();
        continue;
      }
      if (this.is('usingnamespace') || (this.is('pub') && this.is('usingnamespace', 1))) {
        throw new ZigParseError('usingnamespace was removed from Zig in 0.15.', t.line);
      }
      const declStart = this.peek().start;
      let pub = false;
      if (this.accept('pub')) pub = true;
      // Declaration modifiers.
      let isExtern = false;
      for (;;) {
        if (this.accept('export') || this.accept('inline') || this.accept('noinline') || this.accept('threadlocal')) continue;
        if (this.is('extern')) {
          if (this.is('struct', 1) || this.is('union', 1)) break;
          this.next();
          isExtern = true;
          if (this.peek().kind === 'string') this.next();
          continue;
        }
        break;
      }
      if (this.is('fn')) {
        c.decls.push(this.fnDecl(pub, isExtern, declStart));
        continue;
      }
      if (this.is('const') || this.is('var')) {
        c.decls.push(this.varDecl(pub, declStart));
        continue;
      }
      if (pub || isExtern) throw new ZigParseError(`Expected a declaration after '${pub ? 'pub' : 'extern'}'.`, t.line);
      c.fields.push(this.field(c));
      if (!this.accept(',')) {
        if (!this.is(closing)) {
          const n = this.peek();
          throw new ZigParseError(`Expected ',' after a field, found ${n.kind === 'eof' ? 'end of input' : `'${n.text}'`}.`, n.line);
        }
      }
    }
  }

  private field(c: ContainerDecl): FieldDecl {
    const start = this.peek().start;
    const line = this.peek().line;
    const isComptime = this.accept('comptime');
    const f: FieldDecl = { comptime: isComptime, line, start, end: start };
    const nameToken = this.peek().kind === 'ident' && (!KEYWORDS.has(this.peek().text) || this.peek().quoted === true);
    // A struct field without ':' is a tuple field (a type); a union field without one is void.
    const named =
      nameToken &&
      (this.is(':', 1) || (c.kind === 'union' && (this.is(',', 1) || this.is('=', 1) || this.is('}', 1) || this.is('align', 1))));
    if (c.kind === 'enum') {
      const name = this.identifier().text;
      if (name === '_') c.nonexhaustive = true;
      f.name = name;
      if (this.accept('=')) f.value = this.expr();
    } else if (named) {
      f.name = this.identifier().text;
      if (this.accept(':')) this.fieldType(f);
      else if (c.kind === 'struct') throw new ZigParseError(`Field '${f.name}' needs a type.`, line);
    } else {
      // A tuple field: a type only.
      if (c.kind !== 'struct') throw new ZigParseError('Expected a field name.', line);
      this.fieldType(f);
    }
    if (this.accept('align')) {
      this.expect('(');
      f.align = this.expr();
      this.expect(')');
    }
    if (c.kind !== 'enum' && this.accept('=')) f.value = this.expr();
    f.end = this.tokens[this.pos - 1]!.end;
    return f;
  }

  private fieldType(f: FieldDecl): void {
    f.typeStart = this.peek().start;
    f.type = this.typeExpr();
    f.typeEnd = this.tokens[this.pos - 1]!.end;
  }

  /** ContainerDecl, at `extern`, `packed`, `struct`, `union`, `enum` or `opaque`. */
  containerDecl(): ContainerDecl {
    const first = this.peek();
    let layout: ContainerDecl['layout'] = 'auto';
    if (this.accept('extern')) layout = 'extern';
    else if (this.accept('packed')) layout = 'packed';
    const kw = this.next();
    if (kw.text !== 'struct' && kw.text !== 'union' && kw.text !== 'enum' && kw.text !== 'opaque') {
      throw new ZigParseError(`Expected struct, union, enum or opaque, found '${kw.text}'.`, kw.line);
    }
    const c: ContainerDecl = {
      kind: kw.text,
      layout,
      fields: [],
      decls: [],
      nonexhaustive: false,
      line: first.line,
      start: first.start,
      end: first.start,
      bodyStart: 0,
      bodyEnd: 0,
    };
    if (this.accept('(')) {
      if (c.kind === 'union' && this.is('enum')) {
        this.next();
        c.unionEnum = true;
        if (this.accept('(')) {
          c.unionEnumArg = this.expr();
          this.expect(')');
        }
      } else {
        c.arg = this.expr();
      }
      this.expect(')');
    }
    c.bodyStart = this.expect('{').start;
    this.containerMembers(c, '}');
    const close = this.expect('}');
    c.bodyEnd = close.start;
    c.end = close.end;
    return c;
  }

  // ------------------------------------------------------------------ declarations

  private varDecl(pub: boolean, start: number): Decl {
    const kw = this.next();
    const name = this.identifier();
    const d: Decl = { name: name.text, pub, kind: kw.text as 'const' | 'var', line: name.line, start, end: start };
    if (this.accept(':')) d.type = this.typeExpr();
    if (this.accept('align')) this.skipGroup();
    if (this.accept('linksection')) this.skipGroup();
    if (this.accept('addrspace')) this.skipGroup();
    if (this.accept('=')) d.value = this.expr();
    d.end = this.expect(';').end;
    return d;
  }

  private params(): Param[] {
    this.expect('(');
    const params: Param[] = [];
    while (!this.is(')')) {
      if (this.accept('...')) {
        params.push({ comptime: false });
      } else {
        const p: Param = { comptime: false };
        if (this.accept('comptime')) p.comptime = true;
        else this.accept('noalias');
        if (this.peek().kind === 'ident' && this.is(':', 1)) {
          p.name = this.next().text;
          this.next();
        }
        if (this.accept('anytype')) p.type = undefined;
        else p.type = this.typeExpr();
        params.push(p);
      }
      if (!this.accept(',')) break;
    }
    this.expect(')');
    return params;
  }

  /** What follows the parameters of a prototype: align, addrspace, linksection, callconv. */
  private protoTail(): Expr | undefined {
    let callconv: Expr | undefined;
    for (;;) {
      if (this.accept('align') || this.accept('addrspace') || this.accept('linksection')) {
        this.skipGroup();
        continue;
      }
      if (this.accept('callconv')) {
        this.expect('(');
        callconv = this.expr();
        this.expect(')');
        continue;
      }
      return callconv;
    }
  }

  private fnDecl(pub: boolean, isExtern: boolean, start: number): Decl {
    const line = this.expect('fn').line;
    const name = this.identifier();
    const params = this.params();
    const callconv = this.protoTail();
    // `!T`: an error set inferred from the body. `E!T` is an ordinary type.
    const inferredErrorSet = this.accept('!');
    const ret = this.typeExpr();
    const fn: FnDecl = { params, ret, body: null, ...(callconv && { callconv }), ...(inferredErrorSet && { inferredErrorSet }) };
    if (this.is('{')) {
      if (isExtern) throw new ZigParseError('An extern function has no body.', line);
      const bodyStart = this.pos;
      try {
        fn.body = this.block();
      } catch (err) {
        if (!(err instanceof ZigParseError)) throw err;
        // A body the evaluator cannot run: skip it; calling the function is an error.
        this.pos = bodyStart;
        this.skipGroup();
        fn.body = [];
        fn.unsupported = err.message;
      }
      const d: Decl = { name: name.text, pub, kind: 'fn', fn, line, start, end: this.tokens[this.pos - 1]!.end };
      return d;
    }
    const end = this.expect(';').end;
    return { name: name.text, pub, kind: 'fn', fn, line, start, end };
  }

  private block(): Stmt[] {
    this.expect('{');
    const body: Stmt[] = [];
    while (!this.is('}')) {
      if (this.peek().kind === 'eof') throw new ZigParseError("Expected '}'.", this.peek().line);
      body.push(this.stmt());
    }
    this.expect('}');
    return body;
  }

  private stmt(): Stmt {
    const t = this.peek();
    if (this.is('const') || this.is('var') || (this.is('comptime') && (this.is('var', 1) || this.is('const', 1)))) {
      this.accept('comptime');
      return { k: 'decl', decl: this.varDecl(false, t.start) };
    }
    if (this.accept('return')) {
      const e = this.is(';') ? undefined : this.expr();
      this.expect(';');
      return { k: 'return', e, line: t.line };
    }
    if (this.is('{')) return { k: 'block', body: this.block() };
    if (this.accept('if')) {
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      const capture = this.capture();
      const then = this.blockOrExprStmt();
      const otherwise = this.accept('else') ? this.blockOrExprStmt() : undefined;
      return { k: 'if', cond, capture, then, else: otherwise, line: t.line };
    }
    if (this.is('while') || this.is('for') || this.is('switch') || this.is('defer') || this.is('errdefer') || this.is('inline')) {
      throw new ZigParseError(`'${t.text}' is not supported in a function that returns a type.`, t.line);
    }
    if (this.is('_') && this.is('=', 1)) {
      this.next();
      this.next();
      const e = this.expr();
      this.expect(';');
      return { k: 'expr', e, line: t.line };
    }
    const e = this.expr();
    const assign = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '+%=', '-%=', '*%=', '+|=', '-|=', '*|=', '<<|='].find((op) => this.is(op));
    if (assign) {
      this.next();
      const value = this.expr();
      this.expect(';');
      return { k: 'assign', target: e, value, line: t.line };
    }
    if (!this.is(';')) throw new ZigParseError('Only declarations, assignments, return and if are supported in a function that returns a type.', t.line);
    this.next();
    return { k: 'expr', e, line: t.line };
  }

  /** SwitchExpr: `switch (x) { a, b => e, lo...hi => f, else => g }`. */
  private switchExpr(): Expr {
    const line = this.expect('switch').line;
    this.expect('(');
    const subject = this.expr();
    this.expect(')');
    this.expect('{');
    const prongs: SwitchProng[] = [];
    while (!this.is('}')) {
      if (this.is('inline')) throw new ZigParseError('inline switch prongs are not supported.', this.peek().line);
      const prong: SwitchProng = { items: [], isElse: false, body: { k: 'int', v: 0n, line } };
      if (this.accept('else')) {
        prong.isElse = true;
      } else {
        for (;;) {
          const from = this.expr();
          if (this.accept('...')) prong.items.push({ from, to: this.expr() });
          else prong.items.push({ value: from });
          if (!this.accept(',') || this.is('=>')) break;
        }
      }
      this.expect('=>');
      if (this.is('|')) throw new ZigParseError('Switch prong captures are not supported.', this.peek().line);
      prong.body = this.expr();
      prongs.push(prong);
      if (!this.accept(',')) break;
    }
    this.expect('}');
    return { k: 'switch', subject, prongs, line };
  }

  /** PtrPayload: `|name|` after the condition of an `if`. */
  private capture(): string | undefined {
    if (!this.accept('|')) return undefined;
    if (this.is('*')) throw new ZigParseError('A pointer capture (|*x|) is not supported here.', this.peek().line);
    const name = this.identifier().text;
    this.expect('|');
    return name;
  }

  private blockOrExprStmt(): Stmt {
    if (this.is('{')) return { k: 'block', body: this.block() };
    return this.stmt();
  }

  // ------------------------------------------------------------------ expressions

  expr(): Expr {
    return this.binary(0);
  }

  private binaryOp(level: number): string | undefined {
    const t = this.peek();
    if (t.kind !== 'punct' && t.kind !== 'ident') return undefined;
    if (!BINARY_LEVELS[level]!.includes(t.text)) return undefined;
    if (t.kind === 'ident' && !['or', 'and', 'orelse', 'catch'].includes(t.text)) return undefined;
    return t.text;
  }

  private binary(level: number): Expr {
    if (level >= BINARY_LEVELS.length) return this.prefix();
    let l = this.binary(level + 1);
    for (;;) {
      const op = this.binaryOp(level);
      if (!op) return l;
      const line = this.next().line;
      if (op === 'catch' && this.is('|')) throw new ZigParseError('catch with a capture is not supported here.', line);
      const r = this.binary(level + 1);
      l = { k: 'binary', op, l, r, line };
      // Comparisons do not chain.
      if (level === 2) return l;
    }
  }

  private prefix(): Expr {
    const t = this.peek();
    if (t.kind === 'punct' && (t.text === '!' || t.text === '-' || t.text === '~' || t.text === '-%' || t.text === '&')) {
      this.next();
      return { k: 'unary', op: t.text, e: this.prefix(), line: t.line };
    }
    if (this.is('try')) {
      this.next();
      return { k: 'unary', op: 'try', e: this.prefix(), line: t.line };
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.peek();
    if (this.is('if')) {
      this.next();
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      const capture = this.capture();
      const then = this.expr();
      const otherwise = this.accept('else') ? this.expr() : undefined;
      return { k: 'if', cond, capture, then, else: otherwise, line: t.line };
    }
    if (this.is('comptime')) {
      this.next();
      return { k: 'comptime', e: this.expr(), line: t.line };
    }
    if (this.is('while') || this.is('for') || this.is('break') || this.is('continue') || this.is('return') || this.is('asm')) {
      throw new ZigParseError(`'${t.text}' expressions are not supported.`, t.line);
    }
    const type = this.typeExpr();
    // CurlySuffixExpr: an initializer list after the type.
    if (this.is('{')) {
      this.skipGroup();
      return { k: 'init', type, line: t.line };
    }
    return type;
  }

  /** TypeExpr <- PrefixTypeOp* ErrorUnionExpr */
  typeExpr(): Expr {
    const t = this.peek();
    if (this.accept('?')) return { k: 'optional', child: this.typeExpr(), line: t.line };
    if (this.is('*') || this.is('**')) {
      const double = this.next().text === '**';
      const inner = this.pointerRest('one', undefined, t.line);
      return double ? { k: 'pointer', size: 'one', isConst: false, isVolatile: false, allowzero: false, child: inner, line: t.line } : inner;
    }
    if (this.is('[')) {
      this.next();
      if (this.is('*')) {
        this.next();
        let size: 'many' | 'c' = 'many';
        let sentinel: Expr | undefined;
        if (this.peek().kind === 'ident' && this.peek().text === 'c' && this.is(']', 1)) {
          this.next();
          size = 'c';
        } else if (this.accept(':')) {
          sentinel = this.expr();
        }
        this.expect(']');
        return this.pointerRest(size, sentinel, t.line);
      }
      if (this.accept(']')) return this.pointerRest('slice', undefined, t.line);
      if (this.accept(':')) {
        const sentinel = this.expr();
        this.expect(']');
        return this.pointerRest('slice', sentinel, t.line);
      }
      let len: Expr | 'infer';
      if (this.is('_') && (this.is(']', 1) || this.is(':', 1))) {
        this.next();
        len = 'infer';
      } else {
        len = this.expr();
      }
      let sentinel: Expr | undefined;
      if (this.accept(':')) sentinel = this.expr();
      this.expect(']');
      return { k: 'array', len, sentinel, child: this.typeExpr(), line: t.line };
    }
    const s = this.suffix();
    if (this.is('!') && !this.is('=', 1)) {
      this.next();
      return { k: 'errorUnion', set: s, payload: this.typeExpr(), line: t.line };
    }
    return s;
  }

  private pointerRest(size: 'one' | 'many' | 'slice' | 'c', sentinel: Expr | undefined, line: number): Expr {
    let isConst = false;
    let isVolatile = false;
    let allowzero = false;
    let align: Expr | undefined;
    for (;;) {
      if (this.accept('const')) isConst = true;
      else if (this.accept('volatile')) isVolatile = true;
      else if (this.accept('allowzero')) allowzero = true;
      else if (this.accept('align')) {
        this.expect('(');
        align = this.expr();
        // Bit-pointer alignment: align(a:b:h).
        while (this.accept(':')) this.expr();
        this.expect(')');
      } else if (this.accept('addrspace')) this.skipGroup();
      else break;
    }
    return { k: 'pointer', size, sentinel, align, isConst, isVolatile, allowzero, child: this.typeExpr(), line };
  }

  /** SuffixExpr: a primary type expression followed by .field, (call), [index], .*, .? */
  private suffix(): Expr {
    let e = this.primaryType();
    for (;;) {
      const t = this.peek();
      if (this.is('.') && this.peek(1).kind === 'ident') {
        this.next();
        e = { k: 'field', obj: e, name: this.next().text, line: t.line };
        continue;
      }
      if (this.accept('.*')) {
        e = { k: 'deref', e, line: t.line };
        continue;
      }
      if (this.accept('.?')) {
        e = { k: 'unwrap', e, line: t.line };
        continue;
      }
      if (this.is('(')) {
        e = { k: 'call', fn: e, args: this.args(), line: t.line };
        continue;
      }
      if (this.is('[')) {
        this.next();
        const index = this.expr();
        if (this.is('..')) throw new ZigParseError('Slicing is not supported here.', t.line);
        this.expect(']');
        e = { k: 'index', obj: e, index, line: t.line };
        continue;
      }
      return e;
    }
  }

  private args(): Expr[] {
    this.expect('(');
    const args: Expr[] = [];
    while (!this.is(')')) {
      args.push(this.expr());
      if (!this.accept(',')) break;
    }
    this.expect(')');
    return args;
  }

  private primaryType(): Expr {
    const t = this.peek();
    switch (t.kind) {
      case 'builtin':
        this.next();
        return { k: 'builtin', name: t.text, args: this.args(), line: t.line };
      case 'int':
      case 'char':
        this.next();
        return { k: 'int', v: t.value!, line: t.line };
      case 'float':
        this.next();
        return { k: 'float', text: t.text, line: t.line };
      case 'string':
        this.next();
        return { k: 'string', v: t.text, line: t.line };
      case 'eof':
        throw new ZigParseError('Unexpected end of input.', t.line);
      default:
        break;
    }
    if (this.is('.')) {
      this.next();
      if (this.is('{')) {
        this.skipGroup();
        return { k: 'init', line: t.line };
      }
      return { k: 'enumLit', name: this.identifier().text, line: t.line };
    }
    if (this.is('(')) {
      this.next();
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (this.is('error')) {
      this.next();
      if (this.accept('.')) return { k: 'errorValue', name: this.identifier().text, line: t.line };
      this.expect('{');
      const names: string[] = [];
      while (!this.is('}')) {
        names.push(this.identifier().text);
        if (!this.accept(',')) break;
      }
      this.expect('}');
      return { k: 'errorSet', names, line: t.line };
    }
    if (this.is('extern') || this.is('packed') || this.is('struct') || this.is('union') || this.is('enum') || this.is('opaque')) {
      return { k: 'container', c: this.containerDecl(), line: t.line };
    }
    if (this.is('if')) {
      // IfTypeExpr
      this.next();
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      const capture = this.capture();
      const then = this.typeExpr();
      const otherwise = this.accept('else') ? this.typeExpr() : undefined;
      return { k: 'if', cond, capture, then, else: otherwise, line: t.line };
    }
    if (this.is('switch')) return this.switchExpr();
    if (this.accept('unreachable')) return { k: 'unreachable', line: t.line };
    if (this.is('anyframe')) throw new ZigParseError('anyframe is not supported.', t.line);
    if (this.is('fn')) {
      this.next();
      const params = this.params();
      const callconv = this.protoTail();
      if (this.is('!')) throw new ZigParseError('A function type cannot infer its error set (!T): name it, as in anyerror!T.', t.line);
      const ret = this.typeExpr();
      return { k: 'fnType', params, ret, callconv, line: t.line };
    }
    if (t.kind === 'ident') {
      if (KEYWORDS.has(t.text) && !t.quoted) {
        throw new ZigParseError(`Unexpected '${t.text}'.`, t.line);
      }
      this.next();
      return { k: 'ident', name: t.text, line: t.line };
    }
    throw new ZigParseError(`Unexpected '${t.text}'.`, t.line);
  }
}

export function parseZig(source: string): ZigFile {
  const root: ContainerDecl = {
    kind: 'struct',
    layout: 'auto',
    fields: [],
    decls: [],
    nonexhaustive: false,
    line: 1,
    start: 0,
    end: source.length,
    bodyStart: 0,
    bodyEnd: source.length,
  };
  const file: ZigFile = { root, source, errors: [], warnings: [] };
  let tokens: ZigToken[];
  try {
    tokens = lexZig(source);
  } catch (err) {
    if (err instanceof ZigLexError) {
      file.errors.push({ message: err.message, line: err.line, type: 'syntax' });
      return file;
    }
    throw err;
  }
  const parser = new Parser(tokens, source);
  try {
    parser.containerMembers(root, '');
  } catch (err) {
    if (err instanceof ZigParseError) file.errors.push({ message: err.message, line: err.line, type: 'syntax' });
    else throw err;
  }
  file.warnings.push(...parser.warnings);
  return file;
}
