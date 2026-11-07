/**
 * Go memory layout, following the gc compiler (go/types gcSizes):
 * - fields are laid out in declaration order (Go never reorders),
 * - a struct's alignment is its largest field alignment,
 * - "the last field of a non-zero-sized struct is not allowed to have size 0": a trailing
 *   zero-size field gets one byte, then the size is rounded up to the alignment.
 *
 * Names resolve by Go's scoping: type parameters, then the package's declarations, then the
 * universe (a package may declare its own `int32`). Array lengths are constant expressions,
 * evaluated with Go's constant semantics for the target (eval.ts).
 *
 * Also computes ptrdata (the prefix the garbage collector scans) and the field order the
 * `fieldalignment` analyzer (golang.org/x/tools) suggests, with that analyzer's own size model.
 */
import { Nesting, NestingError } from '../nesting';
import type { CalculationResult, ParseError, ParsedStruct, StructMember } from '../types';
import { decodeGoString } from './lexer';
import { formatGoType, parseGo } from './parser';
import type { GoConstDecl, GoField, GoFile, GoType, GoTypeDecl, GoVarDecl } from './parser';
import { EvalError, evalGoArrayLength, evalGoConstDecl, evalGoExpr } from './eval';
import type { BasicKind, Entity, EvalHost, Operand, Typ, TypeRef } from './eval';
import { fieldAlignmentMessage, fieldAlignmentOrder } from './fieldalignment';
import { GO_STD_TYPES, STD_PACKAGE_PATHS } from './std';
import { getGoTarget } from './targets';
import type { GoTarget } from './targets';

interface Info {
  size: number;
  align: number;
  /** Bytes from the start up to the end of the last pointer (0 = pointer-free). */
  ptrdata: number;
  /** Layout, when the type is a struct (for nested display). */
  struct?: CalculationResult;
  /** A 64-bit integer (possibly through a named type): the operand type of sync/atomic's 64-bit functions. */
  int64?: boolean;
}

class LayoutError extends Error {
  constructor(message: string, public line?: number) {
    super(message);
  }
}

const alignUp = (n: number, a: number) => Math.ceil(n / a) * a;

/** A type parameter's argument, and the scope it was written in. */
interface Binding {
  type: GoType;
  scope: Scope;
}

export interface Scope {
  file: GoFile;
  /** Type parameters of the generic being instantiated, bound to their arguments. */
  subst: Map<string, Binding>;
  /** Package path whose names are in scope (std definitions refer to siblings unqualified). */
  stdPackage?: string;
}

const emptyFile = (): GoFile => ({ imports: new Map(), types: new Map(), order: [], consts: new Map(), vars: new Map(), errors: [] });

/** The universe: only the predeclared names. */
const UNIVERSE: Scope = { file: emptyFile(), subst: new Map() };

const BASIC_TYPES = new Set([
  'bool', 'string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128', 'byte', 'rune',
]);
const BUILTINS = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max', 'min', 'new', 'panic',
  'print', 'println', 'real', 'recover',
]);

/** byte and rune are aliases. */
const canonicalBasic = (name: string) => (name === 'byte' ? 'uint8' : name === 'rune' ? 'int32' : name);

interface StdDecl {
  type: GoType;
  align?: number;
  typeParams: string[];
  file: GoFile;
}

const stdCache = new Map<string, StdDecl>();
function stdDecl(key: string): StdDecl | undefined {
  const entry = GO_STD_TYPES[key];
  if (!entry) return undefined;
  let decl = stdCache.get(key);
  if (!decl) {
    const file = parseGo(`package std\ntype T ${entry.source}`);
    decl = { type: file.types.get('T')!.type, align: entry.align, typeParams: entry.typeParams ?? [], file };
    stdCache.set(key, decl);
  }
  return decl;
}

/** What an unqualified or qualified type name denotes. */
type Resolved =
  | { kind: 'param'; binding: Binding }
  | { kind: 'basic'; name: string }
  | { kind: 'decl'; decl: GoTypeDecl; scope: Scope; key: string }
  | { kind: 'std'; decl: StdDecl; scope: Scope; key: string };

/**
 * The size model: 'gc' is go/types' (and the compiler's); 'fieldalignment' is the analyzer's own
 * gcSizes, which aligns every non-aggregate type to min(size, maxAlign) (so complex64 is
 * 8-aligned on 64-bit targets) and does not know sync/atomic's align64.
 */
export type GoSizesModel = 'gc' | 'fieldalignment';

export class GoLayoutEngine implements EvalHost {
  private visiting = new Set<string>();
  private constants = new Map<GoConstDecl, Operand>();
  private constVisiting = new Set<GoConstDecl>();
  private variables = new Map<GoVarDecl, Typ>();
  private varVisiting = new Set<GoVarDecl>();
  /** Constants and array lengths are go/types' whatever the model. */
  private gc: GoLayoutEngine;
  readonly universe = UNIVERSE;

  /**
   * Every type and expression worked out inside another is one level deeper, a named type's
   * definition included, so a chain of declarations counts as deep as it goes (nesting.ts).
   */
  constructor(
    private target: GoTarget,
    private file: GoFile,
    private model: GoSizesModel = 'gc',
    readonly nesting: Nesting = new Nesting(),
  ) {
    this.gc = model === 'gc' ? this : new GoLayoutEngine(target, file, 'gc', nesting);
  }

  get wordSize(): number {
    return this.target.wordSize;
  }

  /** The package scope of the file. */
  get packageScope(): Scope {
    return { file: this.file, subst: new Map() };
  }

  private basic(name: string): Info | undefined {
    const w = this.target.wordSize;
    const m = this.target.maxAlign;
    const scalar = (size: number, align = size): Info => ({ size, align: Math.min(align, m), ptrdata: 0 });
    switch (canonicalBasic(name)) {
      case 'bool': case 'int8': case 'uint8': return scalar(1);
      case 'int16': case 'uint16': return scalar(2);
      case 'int32': case 'uint32': case 'float32': return scalar(4);
      case 'int64': case 'uint64': return { ...scalar(8), int64: true };
      case 'float64': return scalar(8);
      // gc aligns complex values like [2]float32 / [2]float64; fieldalignment by their size.
      case 'complex64': return scalar(8, this.model === 'gc' ? 4 : 8);
      case 'complex128': return scalar(16, this.model === 'gc' ? 8 : 16);
      case 'int': case 'uint': case 'uintptr': return scalar(w);
      case 'string': return { size: 2 * w, align: w, ptrdata: w };
      case 'any': case 'error': return { size: 2 * w, align: w, ptrdata: 2 * w };
      case 'unsafe.Pointer': return { size: w, align: w, ptrdata: w };
      default: return undefined;
    }
  }

  // ------------------------------------------------------------------ names

  private resolve(type: Extract<GoType, { kind: 'name' }>, scope: Scope, line?: number): Resolved {
    const noArgs = (r: Resolved) => {
      if (type.typeArgs) throw new LayoutError(`'${type.name}' is not a generic type.`, line);
      return r;
    };
    if (!type.pkg) {
      const binding = scope.subst.get(type.name);
      if (binding) return noArgs({ kind: 'param', binding });
      if (scope.stdPackage !== undefined) {
        const std = stdDecl(`${scope.stdPackage}.${type.name}`);
        if (std) return this.instantiateStd(type, std, `${scope.stdPackage}.${type.name}`, scope, line);
      } else {
        // Package scope shadows the universe (spec: "Declarations and scope").
        const decl = scope.file.types.get(type.name);
        if (decl) return this.instantiate(type, decl, scope, line);
        if (scope.file.consts.has(type.name) || scope.file.vars.has(type.name)) {
          throw new LayoutError(`'${type.name}' is not a type.`, line);
        }
      }
      if (BASIC_TYPES.has(type.name) || type.name === 'any' || type.name === 'error') return noArgs({ kind: 'basic', name: type.name });
      if (type.name === 'comparable') throw new LayoutError("Cannot use type 'comparable' outside a type constraint.", line);
      throw new LayoutError(`Unknown type '${formatGoType(type)}'.`, line);
    }
    // A std type, either qualified (time.Time) or inside a std definition, where sibling
    // packages are named by short name (sync.Mutex inside sync.RWMutex).
    const stdPath = scope.stdPackage !== undefined ? STD_PACKAGE_PATHS[type.pkg] : scope.file.imports.get(type.pkg) ?? STD_PACKAGE_PATHS[type.pkg];
    if (stdPath === 'unsafe' && type.name === 'Pointer') return noArgs({ kind: 'basic', name: 'unsafe.Pointer' });
    if (stdPath !== undefined) {
      const std = stdDecl(`${stdPath}.${type.name}`);
      if (std) return this.instantiateStd(type, std, `${stdPath}.${type.name}`, scope, line);
    }
    throw new LayoutError(
      stdPath === undefined
        ? `Unknown package '${type.pkg}' in '${formatGoType(type)}': add its import, or declare the type in the input.`
        : `Unknown type '${formatGoType(type)}': only common standard-library types are built in. Declare it in the input to lay it out.`,
      line,
    );
  }

  /** Type arguments, checked against the parameters, bound in the scope they are written in. */
  private bind(type: Extract<GoType, { kind: 'name' }>, name: string, params: string[], scope: Scope, line?: number): Map<string, Binding> {
    if (params.length === 0) {
      if (type.typeArgs) throw new LayoutError(`'${name}' is not a generic type.`, line);
      return new Map();
    }
    if (!type.typeArgs || type.typeArgs.length !== params.length) {
      throw new LayoutError(`Generic type '${name}' needs ${params.length} type argument(s), e.g. ${name}[${params.map(() => 'int').join(', ')}].`, line);
    }
    return new Map(params.map((p, i) => [p, { type: type.typeArgs![i], scope }]));
  }

  private argsKey(type: Extract<GoType, { kind: 'name' }>, scope: Scope, line?: number): string {
    return type.typeArgs ? `[${type.typeArgs.map((a) => this.typeKey(a, scope, line)).join(',')}]` : '';
  }

  private instantiate(type: Extract<GoType, { kind: 'name' }>, decl: GoTypeDecl, scope: Scope, line?: number): Resolved {
    const subst = this.bind(type, decl.name, decl.typeParams, scope, line);
    return { kind: 'decl', decl, scope: { file: scope.file, subst }, key: `.${decl.name}${this.argsKey(type, scope, line)}` };
  }

  private instantiateStd(type: Extract<GoType, { kind: 'name' }>, decl: StdDecl, path: string, scope: Scope, line?: number): Resolved {
    const subst = this.bind(type, path, decl.typeParams, scope, line);
    const stdPackage = path.slice(0, path.lastIndexOf('.'));
    return { kind: 'std', decl, scope: { file: decl.file, subst, stdPackage }, key: `${path}${this.argsKey(type, scope, line)}` };
  }

  /** Runs `f` with `key` marked as being expanded; meeting it again means the type contains itself. */
  private expanding<T>(key: string, message: string, line: number | undefined, f: () => T): T {
    if (this.visiting.has(key)) throw new LayoutError(message, line);
    this.visiting.add(key);
    try {
      return f();
    } finally {
      this.visiting.delete(key);
    }
  }

  /** A string that is equal for two types exactly when they are identical (spec: "Type identity"). */
  typeKey(type: GoType, scope: Scope, line?: number): string {
    return this.nesting.in(() => this.typeKeyHere(type, scope, line), line);
  }

  private typeKeyHere(type: GoType, scope: Scope, line?: number): string {
    switch (type.kind) {
      case 'name': {
        const r = this.resolve(type, scope, line);
        switch (r.kind) {
          case 'param': return this.typeKey(r.binding.type, r.binding.scope, line);
          case 'basic': return r.name === 'any' ? 'interface{}' : canonicalBasic(r.name);
          case 'std': return r.key;
          case 'decl':
            if (!r.decl.alias) return r.key;
            return this.expanding(`alias:${r.key}`, `Invalid recursive type alias '${r.decl.name}'.`, r.decl.line, () => this.typeKey(r.decl.type, r.scope, r.decl.line));
        }
        break;
      }
      case 'pointer': return `*${this.typeKey(type.elem, scope, line)}`;
      case 'slice': return `[]${this.typeKey(type.elem, scope, line)}`;
      case 'array': return `[${this.arrayLen(type, scope, line)}]${this.typeKey(type.elem, scope, line)}`;
      case 'map': return `map[${this.typeKey(type.key, scope, line)}]${this.typeKey(type.value, scope, line)}`;
      case 'chan': return `chan(${type.dir}) ${this.typeKey(type.elem, scope, line)}`;
      case 'func': {
        const list = (ts: GoType[]) => ts.map((t) => this.typeKey(t, scope, line)).join(',');
        return `func(${list(type.params)}${type.variadic ? '...' : ''})(${list(type.results)})`;
      }
      case 'interface': {
        if (type.empty) return 'interface{}';
        const methods = type.methods.map((m) => `${m.name}${this.typeKey(m.type, scope, line)}`).sort();
        const embedded = type.embedded.map((terms) => terms.map((t) => `${t.tilde ? '~' : ''}${this.typeKey(t.type, scope, line)}`).sort().join('|')).sort();
        return `interface{${[...methods, ...embedded].join(';')}}`;
      }
      case 'struct': {
        const tag = (t?: string) => (t ? JSON.stringify(decodeGoString(t)) : '');
        return `struct{${type.fields.map((f) => `${f.embedded ? '!' : ''}${f.name} ${this.typeKey(f.type, scope, line)} ${tag(f.tag)}`).join(';')}}`;
      }
    }
    throw new LayoutError(`Unknown type '${formatGoType(type)}'.`, line);
  }

  // ------------------------------------------------------------------ layout

  private arrayLen(type: Extract<GoType, { kind: 'array' }>, scope: Scope, line?: number): number {
    if (type.length.kind === 'ellipsis') throw new LayoutError('[...]T is only allowed in composite literals.', line);
    try {
      return evalGoArrayLength(this.gc, type.length, scope, line);
    } catch (err) {
      if (err instanceof EvalError) throw new LayoutError(capitalize(err.message), err.line ?? line);
      throw err;
    }
  }

  info(type: GoType, scope: Scope, line?: number): Info {
    return this.nesting.in(() => this.infoHere(type, scope, line), line);
  }

  private infoHere(type: GoType, scope: Scope, line?: number): Info {
    const w = this.target.wordSize;
    switch (type.kind) {
      case 'pointer': case 'map': case 'chan': case 'func':
        return { size: w, align: w, ptrdata: w };
      case 'slice':
        return { size: 3 * w, align: w, ptrdata: w };
      case 'interface':
        return { size: 2 * w, align: w, ptrdata: 2 * w };
      case 'array': {
        const length = this.arrayLen(type, scope, line);
        const elem = this.info(type.elem, scope, line);
        const size = elem.size * length;
        if (!Number.isSafeInteger(size)) throw new LayoutError(`The array type '${formatGoType(type)}' is too large.`, line);
        const ptrdata = length === 0 || elem.ptrdata === 0 ? 0 : (length - 1) * elem.size + elem.ptrdata;
        return { size, align: elem.align, ptrdata };
      }
      case 'struct': {
        const result = this.layoutStruct('struct', type.fields, scope);
        return { size: result.totalSize, align: result.struct.alignment ?? 1, ptrdata: structPtrdata.get(result) ?? 0, struct: result };
      }
      case 'name':
        return this.named(type, scope, line);
    }
  }

  private named(type: Extract<GoType, { kind: 'name' }>, scope: Scope, line?: number): Info {
    const r = this.resolve(type, scope, line);
    switch (r.kind) {
      case 'param':
        return this.info(r.binding.type, r.binding.scope, line);
      case 'basic':
        return this.basic(r.name)!;
      case 'std': {
        const inner = this.expanding(r.key, `Invalid recursive type '${formatGoType(type)}'.`, line, () => this.info(r.decl.type, r.scope, line));
        // sync/atomic's 64-bit types embed align64, which go/types (and gc) align to 8 bytes.
        if (this.model === 'gc' && r.decl.align && r.decl.align > inner.align) {
          const align = r.decl.align;
          return { ...inner, align, size: alignUp(inner.size, align), struct: inner.struct && { ...inner.struct, struct: { ...inner.struct.struct, alignment: align } } };
        }
        return inner;
      }
      case 'decl': {
        const { decl } = r;
        const inner = this.expanding(
          r.key,
          decl.alias ? `Invalid recursive type alias '${decl.name}'.` : `Invalid recursive type '${decl.name}': it contains itself by value (use a pointer).`,
          decl.line,
          () => this.info(decl.type, r.scope, decl.line),
        );
        if (inner.struct && !decl.alias) inner.struct = { ...inner.struct, struct: { ...inner.struct.struct, name: type.name } };
        return inner;
      }
    }
  }

  /** Lay out struct fields in the given order. */
  layoutStruct(name: string, fields: readonly GoField[], scope: Scope): CalculationResult {
    const members: CalculationResult['members'] = [];
    let offset = 0;
    let maxAlign = 1;
    let ptrdata = 0;
    for (const f of fields) {
      const info = this.info(f.type, scope, f.line);
      maxAlign = Math.max(maxAlign, info.align);
      const at = alignUp(offset, info.align);
      const member: StructMember = { name: f.name, type: formatGoType(f.type), line: f.line };
      if (info.struct) {
        member.isNested = true;
        member.nestedStruct = info.struct.struct;
      }
      members.push({ member, offset: at, size: info.size, padding: at - offset, alignment: info.align, nested: info.struct });
      if (info.ptrdata > 0) ptrdata = at + info.ptrdata;
      offset = at + info.size;
    }
    // gc: a trailing zero-size field in a non-zero-size struct gets one byte, so a pointer to it
    // cannot point past the end of the struct.
    const last = members[members.length - 1];
    if (last && last.size === 0 && last.offset > 0) offset += 1;
    const totalSize = alignUp(offset, maxAlign);
    const totalPadding = totalSize - members.reduce((s, m) => s + m.size, 0);
    const struct: ParsedStruct = { name, members: members.map((m) => m.member), totalSize, alignment: maxAlign, totalPadding };
    const result: CalculationResult = {
      struct,
      members,
      totalSize,
      totalPadding,
      wastedSpace: totalPadding,
      efficiency: totalSize > 0 ? ((totalSize - totalPadding) / totalSize) * 100 : 0,
      architecture: this.target.id,
    };
    structPtrdata.set(result, ptrdata);
    return result;
  }

  /** The order golang.org/x/tools/go/analysis/passes/fieldalignment suggests (in its size model). */
  optimalOrder(fields: readonly GoField[], scope: Scope): GoField[] {
    const elems = fields.map((f, index) => {
      const info = this.info(f.type, scope, f.line);
      return { index, alignof: info.align, sizeof: info.size, ptrdata: info.ptrdata };
    });
    return fieldAlignmentOrder(elems).map((i) => fields[i]);
  }

  // ------------------------------------------------------------------ constants (EvalHost)

  lookup(name: string, scope: unknown): Entity | undefined {
    const s = scope as Scope;
    if (s.subst.has(name)) return { kind: 'type', ref: { type: { kind: 'name', name }, scope: s } };
    if (s.stdPackage === undefined) {
      const c = s.file.consts.get(name);
      if (c) return { kind: 'const', decl: c };
      const v = s.file.vars.get(name);
      if (v) return { kind: 'var', decl: v };
      if (s.file.types.has(name)) return { kind: 'type', ref: { type: { kind: 'name', name }, scope: s } };
      const path = s.file.imports.get(name);
      if (path !== undefined) return { kind: 'package', path };
    } else if (GO_STD_TYPES[`${s.stdPackage}.${name}`]) {
      return { kind: 'type', ref: { type: { kind: 'name', name }, scope: s } };
    }
    if (BASIC_TYPES.has(name) || name === 'any' || name === 'error') return { kind: 'type', ref: { type: { kind: 'name', name }, scope: UNIVERSE } };
    if (name === 'true' || name === 'false' || name === 'iota' || name === 'nil') return { kind: name };
    if (BUILTINS.has(name)) return { kind: 'builtin', name };
    // Standard packages used without an import, as type names may be (time.Duration).
    const path = STD_PACKAGE_PATHS[name];
    if (path !== undefined) return { kind: 'package', path };
    return undefined;
  }

  lookupQualified(path: string, name: string): Entity | undefined {
    if (path === 'unsafe') {
      if (name === 'Pointer') return { kind: 'type', ref: { type: { kind: 'name', pkg: 'unsafe', name }, scope: UNIVERSE } };
      return ['Sizeof', 'Alignof', 'Offsetof', 'Add', 'Slice', 'SliceData', 'String', 'StringData'].includes(name)
        ? { kind: 'builtin', name: `unsafe.${name}` }
        : undefined;
    }
    if (!GO_STD_TYPES[`${path}.${name}`]) return undefined;
    // Written as the std scope sees it, so the path resolves however the file imports it.
    const short = Object.keys(STD_PACKAGE_PATHS).find((k) => STD_PACKAGE_PATHS[k] === path)!;
    return { kind: 'type', ref: { type: { kind: 'name', pkg: short, name }, scope: { ...UNIVERSE, stdPackage: path } } };
  }

  /** The underlying type: a basic type, a type parameter, or a type literal in its scope. */
  private underlying(ref: TypeRef, line?: number): { basic: string } | { param: true } | { literal: TypeRef<Scope> } {
    let { type, scope } = ref as TypeRef<Scope>;
    const seen = new Set<string>();
    for (;;) {
      if (type.kind !== 'name') return { literal: { type, scope } };
      const r = this.resolve(type, scope, line);
      if (r.kind === 'param') return { param: true };
      if (r.kind === 'basic') {
        if (r.name === 'any' || r.name === 'error') return { literal: { type: { kind: 'interface', empty: r.name === 'any', source: r.name === 'any' ? 'interface{}' : 'interface{ Error() string }', methods: [], embedded: [] }, scope: UNIVERSE } };
        return { basic: canonicalBasic(r.name) };
      }
      if (seen.has(r.key)) throw new LayoutError(`Invalid recursive type '${formatGoType(type)}'.`, line);
      seen.add(r.key);
      ({ type, scope } = { type: r.decl.type, scope: r.scope });
    }
  }

  typeOf(ref: TypeRef, line?: number): Typ {
    try {
      const s = ref.scope as Scope;
      const u = this.underlying(ref, line);
      const typ: Typ = { key: this.typeKey(ref.type, s, line), display: formatGoType(ref.type), ref };
      if ('basic' in u) typ.basic = u.basic as BasicKind;
      else if ('param' in u) typ.param = true;
      else typ.under = u.literal;
      return typ;
    } catch (err) {
      if (err instanceof LayoutError) throw new EvalError(err.message, err.line);
      throw err;
    }
  }

  constant(decl: GoConstDecl): Operand {
    const known = this.constants.get(decl);
    if (known) return known;
    if (this.constVisiting.has(decl)) throw new EvalError(`Initialization cycle: constant '${decl.name}' refers to itself.`, decl.line);
    this.constVisiting.add(decl);
    try {
      const value = evalGoConstDecl(this, decl, this.packageScope);
      this.constants.set(decl, value);
      return value;
    } finally {
      this.constVisiting.delete(decl);
    }
  }

  variable(decl: GoVarDecl, line?: number): Typ {
    const known = this.variables.get(decl);
    if (known) return known;
    if (this.varVisiting.has(decl)) throw new EvalError(`Initialization cycle: variable '${decl.name}' refers to itself.`, decl.line);
    this.varVisiting.add(decl);
    try {
      let typ: Typ;
      if (decl.type) {
        typ = this.typeOf({ type: decl.type, scope: this.packageScope }, decl.line);
      } else if (decl.expr) {
        const x = evalGoExpr(this, decl.expr, this.packageScope, undefined, decl.line);
        if (x.mode !== 'constant' && x.mode !== 'value') throw new EvalError(`The initializer of '${decl.name}' is not a value.`, decl.line);
        typ = x.type.untyped ? this.defaultTyp(x.type) : x.type;
      } else {
        throw new EvalError(`The type of variable '${decl.name}' is not known.`, line);
      }
      this.variables.set(decl, typ);
      return typ;
    } finally {
      this.varVisiting.delete(decl);
    }
  }

  private defaultTyp(t: Typ): Typ {
    const name = { bool: 'bool', int: 'int', rune: 'rune', float: 'float64', complex: 'complex128', string: 'string' }[t.untyped!];
    return this.typeOf({ type: { kind: 'name', name }, scope: UNIVERSE });
  }

  private evalInfo(ref: TypeRef, line?: number): Info {
    try {
      return this.info(ref.type, ref.scope as Scope, line);
    } catch (err) {
      if (err instanceof LayoutError) throw new EvalError(err.message, err.line);
      throw err;
    }
  }

  sizeof(ref: TypeRef, line?: number): number {
    return this.evalInfo(ref, line).size;
  }

  alignof(ref: TypeRef, line?: number): number {
    return this.evalInfo(ref, line).align;
  }

  arrayLength(ref: TypeRef, line?: number): number {
    return this.arrayLen(ref.type as Extract<GoType, { kind: 'array' }>, ref.scope as Scope, line);
  }

  variableSize(ref: TypeRef): boolean {
    const seen = new Set<string>();
    const walk = (type: GoType, scope: Scope): boolean => {
      switch (type.kind) {
        case 'array':
          return walk(type.elem, scope);
        case 'struct':
          return type.fields.some((f) => walk(f.type, scope));
        case 'name': {
          const r = this.resolve(type, scope);
          if (r.kind === 'param') return true;
          if (r.kind === 'basic' || seen.has(r.key)) return false;
          seen.add(r.key);
          return walk(r.decl.type, r.scope);
        }
        default:
          return false;
      }
    };
    return walk(ref.type, ref.scope as Scope);
  }

  /** Go's selector rule: the field at the shallowest depth, through embedded fields. */
  field(ref: TypeRef, name: string, line?: number): { ref: TypeRef; offset: number; indirect: boolean } | 'ambiguous' | undefined {
    type Entry = { ref: TypeRef; offset: number; indirect: boolean };
    let level: Entry[] = [{ ref, offset: 0, indirect: false }];
    const seen = new Set<string>();
    while (level.length > 0) {
      const found: Entry[] = [];
      const next: Entry[] = [];
      for (const e of level) {
        let u = this.underlying(e.ref, line);
        let indirect = e.indirect;
        if ('literal' in u && u.literal.type.kind === 'pointer') {
          u = this.underlying({ type: u.literal.type.elem, scope: u.literal.scope }, line);
          indirect = true;
        }
        if (!('literal' in u) || u.literal.type.kind !== 'struct') continue;
        const key = this.typeKey(u.literal.type, u.literal.scope, line);
        if (seen.has(key)) continue;
        seen.add(key);
        const fields = u.literal.type.fields;
        const layout = this.gc.layoutStruct('struct', fields, u.literal.scope);
        fields.forEach((f, i) => {
          const at = e.offset + layout.members[i].offset;
          const fref = { type: f.type, scope: u.literal.scope };
          if (f.name === name) found.push({ ref: fref, offset: at, indirect });
          if (f.embedded) next.push({ ref: fref, offset: at, indirect });
        });
      }
      if (found.length === 1) return found[0];
      if (found.length > 1) return 'ambiguous';
      level = next;
    }
    return undefined;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** ptrdata of each struct layout: the prefix up to the end of the last pointer. */
const structPtrdata = new WeakMap<CalculationResult, number>();

/**
 * go/types' monomorphization check (mono.go): a generic type instantiated, inside its own
 * declaration's expansion, with a type built from its own type parameter needs infinitely many
 * instances ("instantiation cycle"). Vertices are type parameters; an instantiation G[..., A, ...]
 * inside the declaration of D adds an edge from each type parameter of D that A mentions to G's
 * parameter, of weight 0 when A is that parameter itself and 1 otherwise. A cycle of positive
 * weight is an error.
 */
function instantiationCycle(file: GoFile): ParseError | undefined {
  const vertices: Array<{ decl: GoTypeDecl; param: string; weight: number; len: number }> = [];
  const index = new Map<string, number>();
  const vertex = (decl: GoTypeDecl, param: string) => {
    const key = `${decl.name}.${param}`;
    let i = index.get(key);
    if (i === undefined) {
      i = vertices.length;
      vertices.push({ decl, param, weight: 0, len: 0 });
      index.set(key, i);
    }
    return i;
  };
  const edges: Array<{ src: number; dst: number; weight: number; arg: GoType }> = [];

  for (const decl of file.types.values()) {
    const params = new Set(decl.typeParams);
    if (params.size === 0) continue;
    const children = (t: GoType): GoType[] => {
      switch (t.kind) {
        case 'name': return t.typeArgs ?? [];
        case 'pointer': case 'slice': case 'array': case 'chan': return [t.elem];
        case 'map': return [t.key, t.value];
        case 'func': return [...t.params, ...t.results];
        case 'interface': return t.methods.map((m) => m.type);
        case 'struct': return t.fields.map((f) => f.type);
      }
    };
    // Every instantiation in the declaration's right-hand side.
    const visit = (t: GoType) => {
      if (t.kind === 'name' && !t.pkg && t.typeArgs && !params.has(t.name)) {
        const g = file.types.get(t.name);
        if (g && g.typeParams.length === t.typeArgs.length) {
          t.typeArgs.forEach((arg, i) => {
            const dst = vertex(g, g.typeParams[i]);
            const flow = (x: GoType) => {
              if (x.kind === 'name' && !x.pkg && params.has(x.name) && !x.typeArgs) {
                edges.push({ src: vertex(decl, x.name), dst, weight: x === arg ? 0 : 1, arg });
              }
              children(x).forEach(flow);
            };
            flow(arg);
          });
        }
      }
      children(t).forEach(visit);
    };
    visit(decl.type);
  }

  // Bellman-Ford for the heaviest paths, stopping at a path as long as there are vertices.
  let again = true;
  while (again) {
    again = false;
    for (const edge of edges) {
      const src = vertices[edge.src];
      const dst = vertices[edge.dst];
      const w = src.weight + edge.weight;
      if (w <= dst.weight) continue;
      dst.len = src.len + 1;
      if (dst.len === vertices.length) {
        return {
          message: `Instantiation cycle: type parameter '${dst.param}' of '${dst.decl.name}' is instantiated as ${formatGoType(edge.arg)}, which grows without end.`,
          line: dst.decl.line,
          type: 'semantic',
        };
      }
      dst.weight = w;
      again = true;
    }
  }
  return undefined;
}

export interface GoAnalysis {
  target: GoTarget;
  file: GoFile;
  errors: ParseError[];
  /** The struct type being laid out: the last non-generic struct type declared. */
  definition: { name: string; line: number } | null;
  result: CalculationResult | null;
  optimized: CalculationResult | null;
  /** The root struct's fields as declared, and in the order fieldalignment suggests. */
  fields: GoField[];
  optimizedFields: GoField[];
  /** GC-scanned prefix ("pointer bytes") of both layouts, as gc lays them out. */
  pointerBytes: { current: number; optimized: number } | null;
  /** The message fieldalignment reports for the root struct, or null when it reports none. */
  fieldalignment: string | null;
  /** Bytes the gc rule adds because the last field has size 0. */
  trailingZeroSizePadding: number;
  /** 64-bit fields at offsets that are not multiples of 8 (matters for sync/atomic on 32-bit). */
  unaligned64: string[];
  unusedTypes: string[];
}

export function analyzeGo(code: string, targetId: string): GoAnalysis {
  const target = getGoTarget(targetId);
  const file = parseGo(code);
  const analysis: GoAnalysis = {
    target,
    file,
    errors: [...file.errors],
    definition: null,
    result: null,
    optimized: null,
    fields: [],
    optimizedFields: [],
    pointerBytes: null,
    fieldalignment: null,
    trailingZeroSizePadding: 0,
    unaligned64: [],
    unusedTypes: [],
  };
  if (analysis.errors.length > 0) return analysis;
  const cycle = instantiationCycle(file);
  if (cycle) {
    analysis.errors.push(cycle);
    return analysis;
  }

  const candidates = file.order.filter((n) => {
    const d = file.types.get(n)!;
    return d.type.kind === 'struct' && d.typeParams.length === 0 && !d.alias;
  });
  const rootName = candidates[candidates.length - 1];
  if (!rootName) {
    const generic = file.order.find((n) => file.types.get(n)!.typeParams.length > 0);
    analysis.errors.push({
      message: generic
        ? `Generic type '${generic}' has no layout until it is instantiated. Add a struct that uses it, e.g. type Example struct { v ${generic}[int] }.`
        : 'No struct type found. Declare one with: type Name struct { ... }',
      type: 'semantic',
    });
    return analysis;
  }

  const decl = file.types.get(rootName)!;
  const engine = new GoLayoutEngine(target, file);
  const analyzer = new GoLayoutEngine(target, file, 'fieldalignment');
  const scope = engine.packageScope;
  const fields = (decl.type as Extract<GoType, { kind: 'struct' }>).fields;
  try {
    analysis.definition = { name: rootName, line: decl.line };
    analysis.fields = fields;
    analysis.result = engine.layoutStruct(rootName, fields, scope);
    analysis.optimizedFields = analyzer.optimalOrder(fields, scope);
    analysis.optimized = engine.layoutStruct(rootName, analysis.optimizedFields, scope);
    analysis.pointerBytes = {
      current: structPtrdata.get(analysis.result) ?? 0,
      optimized: structPtrdata.get(analysis.optimized) ?? 0,
    };
    // fieldalignment compares sizes and pointer bytes in its own size model.
    const own = (r: CalculationResult) => ({ size: r.totalSize, ptrdata: structPtrdata.get(r) ?? 0 });
    analysis.fieldalignment = fieldAlignmentMessage(
      rootName,
      own(analyzer.layoutStruct(rootName, fields, scope)),
      own(analyzer.layoutStruct(rootName, analysis.optimizedFields, scope)),
    );
    const last = analysis.result.members[analysis.result.members.length - 1];
    if (last && last.size === 0 && last.offset > 0) {
      // Without the extra byte, the struct would end at the zero-size field, rounded up.
      const align = analysis.result.struct.alignment ?? 1;
      analysis.trailingZeroSizePadding = analysis.result.totalSize - alignUp(last.offset, align);
    }
    analysis.unaligned64 = analysis.result.members
      .filter((m, i) => m.offset % 8 !== 0 && engine.info(fields[i].type, scope).int64)
      .map((m) => m.member.name);
    analysis.unusedTypes = findUnusedTypes(file, rootName);
  } catch (err) {
    if (!(err instanceof LayoutError) && !(err instanceof EvalError) && !(err instanceof NestingError)) throw err;
    analysis.errors.push({ message: capitalize(err.message), line: err.line, type: 'semantic' });
    analysis.result = null;
    analysis.optimized = null;
    analysis.fieldalignment = null;
  }
  return analysis;
}

/** Named types the root struct does not reference, directly or through pointers, slices, maps... */
function findUnusedTypes(file: GoFile, root: string): string[] {
  const used = new Set<string>();
  // Named types go on a worklist: a chain of them (through pointers too) can be any length.
  const pending: string[] = [];
  const visitType = (t: GoType) => {
    switch (t.kind) {
      case 'name':
        if (!t.pkg && file.types.has(t.name) && !used.has(t.name)) {
          used.add(t.name);
          pending.push(t.name);
        }
        t.typeArgs?.forEach(visitType);
        return;
      case 'pointer': case 'slice': case 'array': case 'chan':
        visitType(t.elem);
        return;
      case 'map':
        visitType(t.key);
        visitType(t.value);
        return;
      case 'struct':
        t.fields.forEach((f) => visitType(f.type));
        return;
      case 'func':
        t.params.forEach(visitType);
        t.results.forEach(visitType);
        return;
      case 'interface':
        t.methods.forEach((m) => visitType(m.type));
        t.embedded.forEach((terms) => terms.forEach((term) => visitType(term.type)));
        return;
    }
  };
  used.add(root);
  visitType(file.types.get(root)!.type);
  while (pending.length > 0) visitType(file.types.get(pending.pop()!)!.type);
  return file.order.filter((n) => !used.has(n) && file.types.get(n)!.type.kind === 'struct');
}
