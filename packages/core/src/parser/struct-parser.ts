import type {
  AlignRequest,
  Architecture,
  CalculationResult,
  EnumMember,
  ParseError,
  ParsedEnum,
  ParsedStruct,
  StructMember,
  ValidationResult,
} from '../types';
import type { DataModel } from '../abi/data-models';
import { PaddingCalculator } from '../layout/padding-calculator';
import { ConstExprError, evaluateConstExpr } from './const-expr';
import type { ConstExprContext, TypeOracle } from './const-expr';
import { expandMacros, packAt, preprocess } from './preprocess';
import type { Preprocessed } from './preprocess';
import { findClosing, tokenize } from './tokens';
import type { Token } from './tokens';

/**
 * Parser for C (and the layout-relevant subset of C++) struct, union, enum and typedef
 * declarations.
 *
 * Pipeline: preprocess (comments, #if, #define, #pragma pack) -> tokenize -> expand
 * macros -> recursive-descent declaration parsing with real C declarators, so arrays of
 * pointers, pointers to arrays, function pointers, constant-expression sizes, flexible array
 * members, bit-fields (named, unnamed, zero-width), attributes and typedefs all parse the way a
 * compiler reads them.
 *
 * Parsing is for one target, as compiling is: `sizeof`, `_Alignof` and `offsetof` in a constant
 * expression are worked out as they are reached, from the target's types and the definitions
 * before them, so `char pad[64 - sizeof(struct Head)]` has the size it has on that target.
 */
export interface ParserTarget {
  architecture: Architecture;
  dataModel: DataModel;
}

/** The <stddef.h>, <stdint.h> and <stdbool.h> typedef names, which are built in like the headers. */
const STANDARD_TYPEDEFS: ReadonlyMap<string, 'signed' | 'unsigned'> = new Map([
  ['int8_t', 'signed'], ['int16_t', 'signed'], ['int32_t', 'signed'], ['int64_t', 'signed'],
  ['uint8_t', 'unsigned'], ['uint16_t', 'unsigned'], ['uint32_t', 'unsigned'], ['uint64_t', 'unsigned'],
  ['intptr_t', 'signed'], ['uintptr_t', 'unsigned'], ['ptrdiff_t', 'signed'], ['size_t', 'unsigned'],
  ['ssize_t', 'signed'],
]);

const QUALIFIERS = new Set([
  'const', 'volatile', 'restrict', '__restrict', '__restrict__', '_Atomic', 'mutable', 'register',
  'auto', 'inline', '__inline', '__inline__', 'explicit', 'extern', 'thread_local', '_Thread_local',
  '__thread', '__extension__', '_Noreturn',
]);
/** The qualifiers a type-name (in sizeof, a cast) may start with. */
const TYPE_NAME_QUALIFIERS = new Set(['const', 'volatile', 'restrict', '__restrict', '__restrict__', '_Atomic']);
const BUILTIN_WORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '__signed__',
  '__signed', '_Bool', 'bool', '_Complex', '__int128', 'wchar_t', 'char8_t', 'char16_t', 'char32_t',
]);
const KEYWORDS = new Set([
  ...QUALIFIERS, ...BUILTIN_WORDS, 'struct', 'union', 'class', 'enum', 'typedef', 'static',
  'virtual', 'friend', 'constexpr', 'consteval', 'constinit', 'public', 'private', 'protected',
  'using', 'template', 'typename', 'operator', 'namespace', 'sizeof', 'alignas', '_Alignas',
  '__attribute__', '__attribute', '__declspec', '__packed', 'static_assert', '_Static_assert',
]);
/** GNU attributes that change layout but are not modelled; anything else has no layout effect. */
/** Keywords that start an attribute or alignment specifier (`[[...]]` is handled separately). */
const ATTRIBUTE_KEYWORDS: readonly string[] = ['__attribute__', '__attribute', '__declspec', 'alignas', '_Alignas', '__packed'];
const UNMODELLED_LAYOUT_ATTRIBUTES = new Set(['mode', 'vector_size', 'ms_struct', 'gcc_struct', 'scalar_storage_order', 'designated_init']);

interface Attributes {
  packed?: boolean;
  aligned?: AlignRequest;
}

type RecordKeyword = 'struct' | 'union';

/** What the declaration specifiers name as the base type. */
type BaseSpec =
  | { kind: 'builtin'; words: string[] }
  | { kind: 'name'; name: string }
  | { kind: 'record'; keyword: RecordKeyword; tag?: string; def?: ParsedStruct }
  | { kind: 'enum'; tag?: string; def?: ParsedEnum };

interface Specifiers {
  base?: BaseSpec;
  isTypedef: boolean;
  isStatic: boolean;
  isVirtual: boolean;
  isFriend: boolean;
  attrs: Attributes;
  line: number;
  /** The specifiers as written, for display (e.g. "const char"). */
  written: string;
}

type Derivation = { kind: 'ptr' } | { kind: 'array'; size: number | null } | { kind: 'func'; params: string };

interface Declarator {
  name?: string;
  /** From the name outward: [array, ptr] is "array of pointers". */
  derivations: Derivation[];
  bitWidth?: number;
  attrs: Attributes;
  line: number;
}

/** A resolved type before it becomes a member: what a typedef name stands for. */
interface TypeInfo {
  type: string;
  declaredType?: string;
  isPointer: boolean;
  /** A pointer to a function, not to data. Kept through typedefs and arrays of the type. */
  functionPointer?: boolean;
  dims: number[];
  recordRef?: { keyword: RecordKeyword; name: string };
  nestedStruct?: ParsedStruct;
  enumRef?: string;
  enumType?: ParsedEnum;
  /** Set by an aligned typedef: the type's own alignment (see StructMember.typeAlignment). */
  typeAlignment?: AlignRequest;
  /** For a data pointer: what it points to, for `->` and `*` in constant expressions. */
  pointee?: TypeInfo;
}

class Recover extends Error {}

export class StructParser {
  private errors: ParseError[] = [];
  private warnings: ParseError[] = [];
  private structs: Map<string, ParsedStruct> = new Map();
  private unions: Map<string, ParsedStruct> = new Map();
  private enums: Map<string, ParsedEnum> = new Map();
  private enumAliases: Map<string, string> = new Map();
  private structAliases: Map<string, string> = new Map();
  private typeAliases: Map<string, TypeInfo> = new Map();
  /** Alignment set by an aligned typedef of a struct, union or enum, by alias name. */
  private aliasAlignments: Map<string, AlignRequest> = new Map();
  private enumConstants: Map<string, number> = new Map();
  private definitionOrder: Array<{ name: string; isUnion: boolean }> = [];
  private anonymousTypeCounter = 0;
  private pre: Preprocessed | null = null;
  private tokens: Token[] = [];
  private pos = 0;
  /** Measures types for `sizeof` and friends, with the definitions parsed so far. */
  private readonly calculator: PaddingCalculator;
  private readonly oracle: TypeOracle<TypeInfo>;

  constructor(private readonly target: ParserTarget) {
    this.calculator = new PaddingCalculator(target.architecture, target.dataModel);
    this.oracle = this.createOracle();
  }

  parse(code: string): ValidationResult {
    this.errors = [];
    this.warnings = [];
    this.structs.clear();
    this.unions.clear();
    this.enums.clear();
    this.enumAliases.clear();
    this.structAliases.clear();
    this.typeAliases.clear();
    this.aliasAlignments.clear();
    this.enumConstants.clear();
    this.definitionOrder = [];
    this.anonymousTypeCounter = 0;

    this.pre = preprocess(code);
    this.errors.push(...this.pre.errors);
    this.warnings.push(...this.pre.warnings);
    this.tokens = expandMacros(tokenize(this.pre.text), this.pre.macros, this.errors);
    this.pos = 0;

    while (this.pos < this.tokens.length) {
      const start = this.pos;
      try {
        this.parseTopLevel();
      } catch (err) {
        if (!(err instanceof Recover)) throw err;
        this.skipDeclaration(start);
      }
      if (this.pos === start) this.pos += 1; // never loop forever on unexpected input
    }

    this.resolveReferences();

    if (this.definitionOrder.length === 0 && this.errors.length === 0) {
      this.errors.push({
        message: 'No valid struct or union definition found. Please define at least one struct or union.',
        type: 'semantic',
      });
    }

    return { isValid: this.errors.length === 0, errors: this.errors, warnings: this.warnings };
  }

  // ------------------------------------------------------------------ token helpers

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private isPunct(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.kind === 'punct' && t.value === value;
  }

  private isId(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.kind === 'id' && t.value === value;
  }

  private currentLine(): number {
    return (this.peek() ?? this.tokens[this.tokens.length - 1])?.line ?? 1;
  }

  private fail(message: string, line = this.currentLine()): never {
    this.errors.push({ message, line, type: 'syntax' });
    throw new Recover();
  }

  private expectPunct(value: string, context: string): void {
    if (!this.isPunct(value)) {
      const found = this.peek();
      this.fail(`Expected '${value}' ${context}${found ? ` but found '${found.value}'` : ''}.`);
    }
    this.pos += 1;
  }

  /** Skip the rest of a declaration: up to and including ';' at depth 0, or a balanced block. */
  private skipDeclaration(from: number, stopAtClose = false): void {
    this.pos = Math.max(this.pos, from);
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      if (t.kind === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{')) {
        const close = findClosing(this.tokens, this.pos);
        this.pos = close === -1 ? this.tokens.length : close + 1;
        if (t.value === '{' && !stopAtClose && this.isPunct(';')) this.pos += 1;
        if (t.value === '{' && !stopAtClose) return;
        continue;
      }
      if (t.kind === 'punct' && t.value === '}' && stopAtClose) return;
      this.pos += 1;
      if (t.kind === 'punct' && t.value === ';') return;
    }
  }

  private exprContext(): ConstExprContext<TypeInfo> {
    return { identifier: (name) => this.enumConstants.get(name), types: this.oracle };
  }

  private evaluate(tokens: Token[], what: string, line: number): number {
    try {
      return evaluateConstExpr(tokens, this.exprContext());
    } catch (err) {
      const reason = err instanceof ConstExprError ? err.message : String(err);
      return this.fail(`${what} '${tokens.map((t) => t.value).join(' ')}' is not an integer constant: ${reason}.`, line);
    }
  }

  /** Tokens up to (not including) the first of `stops` at depth 0. */
  private takeUntil(stops: readonly string[]): Token[] {
    const out: Token[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      if (t.kind === 'punct' && stops.includes(t.value)) break;
      if (t.kind === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{')) {
        const close = findClosing(this.tokens, this.pos);
        const end = close === -1 ? this.tokens.length - 1 : close;
        out.push(...this.tokens.slice(this.pos, end + 1));
        this.pos = end + 1;
        continue;
      }
      out.push(t);
      this.pos += 1;
    }
    return out;
  }

  // ------------------------------------------------------------------ top level

  private parseTopLevel(): void {
    const t = this.peek()!;
    if (t.kind === 'punct' && (t.value === ';' || t.value === '}')) {
      this.pos += 1;
      return;
    }
    if (t.kind === 'id' && t.value === 'extern' && this.peek(1)?.kind === 'str') {
      // extern "C" { ... } or extern "C" decl: parse the contents as top level.
      this.pos += 2;
      if (this.isPunct('{')) this.pos += 1;
      return;
    }
    if (t.kind === 'id' && t.value === 'namespace') {
      this.pos += 1;
      while (this.peek()?.kind === 'id' || this.isPunct('::')) this.pos += 1;
      if (this.isPunct('{')) this.pos += 1;
      return;
    }
    if (t.kind === 'id' && (t.value === 'static_assert' || t.value === '_Static_assert')) {
      this.checkStaticAssert();
      return;
    }
    if (t.kind === 'id' && (t.value === 'using' || t.value === 'template')) {
      if (t.value === 'template') {
        this.warnings.push({ message: 'Templates are not laid out: a template has no layout until it is instantiated.', line: t.line, type: 'warning' });
      }
      this.skipDeclaration(this.pos);
      return;
    }

    const spec = this.parseSpecifiers(null, true);
    if (!spec.base) {
      this.fail(`Unexpected '${t.value}' at the top level.`, t.line);
    }

    if (this.isPunct(';')) {
      this.pos += 1;
      this.finishTopLevelRecord(spec, []);
      return;
    }

    const declarators: Declarator[] = [];
    for (;;) {
      const decl = this.parseDeclarator(true);
      declarators.push(decl);
      // Function definition at top level: skip its body.
      if (decl.derivations[0]?.kind === 'func' && this.isPunct('{')) {
        this.skipDeclaration(this.pos);
        this.finishTopLevelRecord(spec, declarators);
        return;
      }
      if (this.isPunct('=')) {
        this.pos += 1;
        this.takeUntil([',', ';']);
      }
      if (this.isPunct(',')) {
        this.pos += 1;
        continue;
      }
      break;
    }

    this.finishTopLevelRecord(spec, declarators);

    if (!this.isPunct(';')) {
      const def = spec.base?.kind === 'record' ? spec.base.def : undefined;
      this.errors.push({
        message: def
          ? `Missing semicolon after ${def.isUnion ? 'union' : 'struct'} definition '${def.name}'.`
          : `Expected ';' after declaration${this.peek() ? ` but found '${this.peek()!.value}'` : ''}.`,
        line: this.currentLine(),
        type: 'syntax',
      });
      throw new Recover();
    }
    this.pos += 1;
  }

  /**
   * `static_assert(condition, "message")` or `_Static_assert(...)`, evaluated as the compiler
   * evaluates it. A false one is an error, as it is for the compiler; one this evaluator cannot
   * work out (C++ type traits, say) is reported as not checked.
   */
  private checkStaticAssert(): void {
    const kw = this.peek()!;
    this.pos += 1;
    if (!this.isPunct('(')) this.fail(`Expected '(' after '${kw.value}'.`);
    const close = findClosing(this.tokens, this.pos);
    if (close === -1) this.fail(`Unterminated '${kw.value}(...)'.`);
    const inner = this.tokens.slice(this.pos + 1, close);
    this.pos = close + 1;

    let depth = 0;
    const comma = inner.findIndex((t) => {
      if (t.kind === 'punct' && (t.value === '(' || t.value === '[')) depth += 1;
      if (t.kind === 'punct' && (t.value === ')' || t.value === ']')) depth -= 1;
      return depth === 0 && t.kind === 'punct' && t.value === ',';
    });
    const condition = comma >= 0 ? inner.slice(0, comma) : inner;
    const message = comma >= 0 ? inner.slice(comma + 1).filter((t) => t.kind === 'str').map((t) => t.value.slice(1, -1)).join('') : '';
    const spelled = condition.map((t) => t.value).join(' ');
    try {
      if (evaluateConstExpr(condition, this.exprContext()) === 0) {
        this.errors.push({
          message: `Static assertion failed${message ? `: "${message}"` : ''} (${spelled}).`,
          line: kw.line,
          type: 'semantic',
        });
      }
    } catch (err) {
      if (!(err instanceof ConstExprError)) throw err;
      this.warnings.push({ message: `${kw.value}(${spelled}) is not checked: ${err.message}.`, line: kw.line, type: 'warning' });
    }
  }

  /** Name, register and order a top-level struct/union/enum, and record typedef aliases. */
  private finishTopLevelRecord(spec: Specifiers, declarators: Declarator[]): void {
    const base = spec.base!;

    if (base.kind === 'record' && base.def) {
      const def = base.def;
      if (!base.tag) {
        // Anonymous record: a typedef gives it its name; otherwise there is no way to refer to it.
        const plainAlias = spec.isTypedef
          ? declarators.find((d) => d.name && d.derivations.length === 0)?.name
          : undefined;
        if (!plainAlias) {
          this.errors.push({
            message: spec.isTypedef
              ? `Anonymous typedef ${base.keyword} detected. Please provide a name.`
              : `Anonymous ${base.keyword} detected. Please provide a name.`,
            line: spec.line,
            type: 'semantic',
          });
          return;
        }
        def.name = plainAlias;
        def.nameIsTypedef = true;
        this.registerRecord(def, true);
      } else {
        this.definitionOrder.push({ name: def.name, isUnion: !!def.isUnion });
      }
    }

    if (base.kind === 'enum' && base.def && !base.tag) {
      const plainAlias = spec.isTypedef ? declarators.find((d) => d.name && d.derivations.length === 0)?.name : undefined;
      if (!plainAlias) {
        if (spec.isTypedef) {
          this.errors.push({ message: 'Anonymous typedef enum detected. Please provide a name.', line: spec.line, type: 'semantic' });
        }
        // A plain anonymous enum only declares constants; that is valid and has no layout.
        return;
      }
      base.def.name = plainAlias;
      this.enums.set(plainAlias, base.def);
    }

    if (!spec.isTypedef) return;
    for (const decl of declarators) {
      if (decl.name) this.registerTypedef(spec, decl);
    }
  }

  private registerTypedef(spec: Specifiers, decl: Declarator): void {
    const name = decl.name!;
    const base = spec.base!;
    // `typedef int a8 __attribute__((aligned(8)));` gives the new type its own alignment.
    const aligned = decl.attrs.aligned ?? spec.attrs.aligned;
    if (decl.derivations.length === 0 && base.kind === 'record') {
      const target = base.def?.name ?? base.tag;
      // `typedef struct Tag Alias;` may precede Tag's definition; references resolve at the end.
      if (target && target !== name) this.structAliases.set(name, target);
      if (aligned !== undefined) this.aliasAlignments.set(name, aligned);
      return;
    }
    if (decl.derivations.length === 0 && base.kind === 'enum') {
      const target = base.def?.name ?? base.tag;
      if (target && target !== name) this.enumAliases.set(name, target);
      if (aligned !== undefined) this.aliasAlignments.set(name, aligned);
      return;
    }
    if (decl.derivations[0]?.kind === 'func') return; // function type alias: never a member type
    const info = this.applyDeclarator(this.baseTypeInfo(spec), decl, name);
    if (info.dims.includes(0)) {
      this.errors.push({ message: `Typedef '${name}' cannot have an array of unknown size.`, line: decl.line, type: 'semantic' });
      return;
    }
    this.typeAliases.set(name, { ...info, declaredType: name, ...(aligned !== undefined && { typeAlignment: aligned }) });
  }

  // ------------------------------------------------------------------ specifiers

  private parseSpecifiers(ownerName: string | null, topLevel: boolean): Specifiers {
    const spec: Specifiers = {
      isTypedef: false,
      isStatic: false,
      isVirtual: false,
      isFriend: false,
      attrs: {},
      line: this.currentLine(),
      written: '',
    };
    const words: string[] = [];
    const written: string[] = [];
    // Keil's and IAR's `__packed struct S { ... }` packs the type, unlike a GCC attribute in that
    // position, which applies to the declaration.
    let packedKeyword = false;

    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.kind === 'punct' && t.value === '[' && this.isPunct('[', 1)) {
        this.parseStdAttributes(spec.attrs);
        continue;
      }
      if (t.kind !== 'id') break;
      const v = t.value;

      if (v === '__attribute__' || v === '__attribute' || v === '__declspec' || v === 'alignas' || v === '_Alignas' || v === '__packed') {
        if (v === '__packed') packedKeyword = true;
        this.parseAttribute(spec.attrs);
        continue;
      }
      if (QUALIFIERS.has(v)) {
        if (v === 'const' || v === 'volatile') written.push(v);
        this.pos += 1;
        continue;
      }
      if (v === 'typedef') { spec.isTypedef = true; this.pos += 1; continue; }
      if (v === 'static' || v === 'constexpr' || v === 'consteval' || v === 'constinit') {
        if (v === 'static') spec.isStatic = true;
        this.pos += 1;
        continue;
      }
      if (v === 'virtual') { spec.isVirtual = true; this.pos += 1; continue; }
      if (v === 'friend') { spec.isFriend = true; this.pos += 1; continue; }
      if (v === 'typename') { this.pos += 1; continue; }

      if (BUILTIN_WORDS.has(v)) {
        if (spec.base && spec.base.kind !== 'builtin') break;
        words.push(v === '__signed__' || v === '__signed' ? 'signed' : v);
        spec.base = { kind: 'builtin', words };
        written.push(v);
        this.pos += 1;
        continue;
      }
      if (v === 'struct' || v === 'union' || v === 'class') {
        if (spec.base) break;
        spec.base = this.parseRecordSpecifier(ownerName, topLevel);
        if (packedKeyword && spec.base.def) spec.base.def.packed = true;
        written.push(`${spec.base.keyword} ${spec.base.def?.name ?? spec.base.tag ?? ''}`.trim());
        continue;
      }
      if (v === 'enum') {
        if (spec.base) break;
        spec.base = this.parseEnumSpecifier(ownerName);
        written.push(`enum ${spec.base.def?.name ?? spec.base.tag ?? ''}`.trim());
        continue;
      }
      if (!spec.base && !KEYWORDS.has(v)) {
        // A typedef name, possibly qualified (std::uint8_t): the last component names the type.
        let name = v;
        this.pos += 1;
        while (this.isPunct('::') && this.peek(1)?.kind === 'id') {
          name = this.peek(1)!.value;
          this.pos += 2;
        }
        if (this.isPunct('<')) {
          this.fail(`Template type '${name}<...>' is not supported.`);
        }
        spec.base = { kind: 'name', name };
        written.push(name);
        continue;
      }
      break;
    }

    spec.written = written.join(' ');
    return spec;
  }

  private parseRecordSpecifier(ownerName: string | null, topLevel: boolean): Extract<BaseSpec, { kind: 'record' }> {
    const kwToken = this.peek()!;
    const keyword: RecordKeyword = kwToken.value === 'union' ? 'union' : 'struct';
    this.pos += 1;
    const attrs: Attributes = {};
    this.parseAttributes(attrs);

    let tag: string | undefined;
    if (this.peek()?.kind === 'id' && !KEYWORDS.has(this.peek()!.value)) {
      tag = this.peek()!.value;
      this.pos += 1;
      while (this.isPunct('::') && this.peek(1)?.kind === 'id') {
        tag = this.peek(1)!.value;
        this.pos += 2;
      }
    }
    this.parseAttributes(attrs);
    if (this.isId('final')) this.pos += 1;

    if (this.isPunct(':') && tag) {
      this.fail(`Inheritance is not modelled: '${keyword} ${tag}' has base classes.`);
    }
    if (!this.isPunct('{')) {
      return { kind: 'record', keyword, tag };
    }

    const open = this.pos;
    const close = findClosing(this.tokens, open);
    if (close === -1) {
      this.fail(`Unterminated ${keyword} definition${tag ? ` '${tag}'` : ''}: missing '}'.`, kwToken.line);
    }

    const name = tag ?? (topLevel ? '' : this.createAnonymousTypeName(keyword, ownerName ?? 'anon'));
    const pragmaPack = this.pre ? packAt(this.pre.packEvents, kwToken.line) : undefined;
    const def: ParsedStruct = { name, members: [], line: kwToken.line };
    if (keyword === 'union') def.isUnion = true;
    if (pragmaPack !== undefined) def.pragmaPack = pragmaPack;

    this.pos = open + 1;
    def.members = this.parseBody(close, def.name || `${keyword} (anonymous)`, def);
    this.pos = close + 1;

    this.parseAttributes(attrs);
    if (attrs.packed) def.packed = true;
    if (attrs.aligned !== undefined) def.alignAttribute = attrs.aligned;

    // Tagged definitions are visible by tag immediately; anonymous top-level ones are named by
    // their typedef in finishTopLevelRecord.
    if (tag) this.registerRecord(def, false);
    else if (!topLevel) this.registerRecord(def, false);
    return { kind: 'record', keyword, tag, def };
  }

  private registerRecord(def: ParsedStruct, ordered: boolean): void {
    const map = def.isUnion ? this.unions : this.structs;
    if (map.has(def.name) && !def.name.startsWith('__anon_')) {
      this.warnings.push({
        message: `${def.isUnion ? 'Union' : 'Struct'} '${def.name}' is redefined. Using the latest definition.`,
        line: def.line,
        type: 'warning',
      });
    }
    map.set(def.name, def);
    if (ordered) this.definitionOrder.push({ name: def.name, isUnion: !!def.isUnion });
  }

  private parseEnumSpecifier(ownerName: string | null): Extract<BaseSpec, { kind: 'enum' }> {
    const kwToken = this.peek()!;
    this.pos += 1;
    if (this.isId('class') || this.isId('struct')) this.pos += 1;
    const attrs: Attributes = {};
    this.parseAttributes(attrs);

    let tag: string | undefined;
    if (this.peek()?.kind === 'id' && !KEYWORDS.has(this.peek()!.value)) {
      tag = this.peek()!.value;
      this.pos += 1;
    }
    this.parseAttributes(attrs);

    let underlyingType: string | undefined;
    if (this.isPunct(':')) {
      this.pos += 1;
      const spec = this.parseSpecifiers(ownerName, false);
      if (!spec.base) this.fail("Expected the enum's underlying type after ':'.");
      underlyingType = this.baseTypeInfo(spec).type;
    }

    if (!this.isPunct('{')) return { kind: 'enum', tag };

    const close = findClosing(this.tokens, this.pos);
    if (close === -1) this.fail(`Unterminated enum definition${tag ? ` '${tag}'` : ''}: missing '}'.`, kwToken.line);
    const name = tag ?? (ownerName ? this.createAnonymousTypeName('enum', ownerName) : '');
    this.pos += 1;
    const members = this.parseEnumerators(close, name || 'enum');
    this.pos = close + 1;
    this.parseAttributes(attrs);

    const def: ParsedEnum = { name, members };
    if (underlyingType) def.underlyingType = underlyingType;
    else if (attrs.packed) def.packed = true;

    if (name) {
      if (this.enums.has(name) && tag) {
        this.warnings.push({ message: `Enum '${name}' is redefined. Using the latest definition.`, line: kwToken.line, type: 'warning' });
      }
      this.enums.set(name, def);
    }
    return { kind: 'enum', tag, def };
  }

  private parseEnumerators(close: number, enumName: string): EnumMember[] {
    const members: EnumMember[] = [];
    let next = 0;
    while (this.pos < close) {
      const t = this.peek()!;
      if (t.kind !== 'id') {
        this.errors.push({ message: `Enum member '${t.value}' in '${enumName}' could not be parsed.`, line: t.line, type: 'syntax' });
        this.pos = close;
        break;
      }
      this.pos += 1;
      const attrs: Attributes = {};
      this.parseAttributes(attrs);
      const member: EnumMember = { name: t.value };
      if (this.isPunct('=')) {
        this.pos += 1;
        const exprTokens: Token[] = [];
        while (this.pos < close && !this.isPunct(',')) exprTokens.push(this.tokens[this.pos++]);
        member.valueRaw = exprTokens.map((x) => x.value).join(' ');
        try {
          next = evaluateConstExpr(exprTokens, this.exprContext());
          member.value = next;
        } catch (err) {
          if (!(err instanceof ConstExprError)) throw err;
          // The values decide the enum's size, so one that cannot be worked out is an error.
          this.errors.push({
            message: `Value of '${t.value}' in '${enumName}', '${member.valueRaw}', is not an integer constant: ${err.message}.`,
            line: t.line,
            type: 'syntax',
          });
          member.value = undefined;
        }
      } else {
        member.value = next;
      }
      if (member.value !== undefined) {
        this.enumConstants.set(member.name, member.value);
        next = member.value + 1;
      }
      members.push(member);
      if (this.isPunct(',')) this.pos += 1;
    }
    return members;
  }

  // ------------------------------------------------------------------ attributes

  private parseAttributes(attrs: Attributes): void {
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'id' && ATTRIBUTE_KEYWORDS.includes(t.value)) {
        this.parseAttribute(attrs);
      } else if (this.isPunct('[') && this.isPunct('[', 1)) {
        this.parseStdAttributes(attrs);
      } else {
        return;
      }
    }
  }

  private parseAttribute(attrs: Attributes): void {
    const t = this.peek()!;
    this.pos += 1;
    if (t.value === '__packed') {
      attrs.packed = true;
      return;
    }
    if (!this.isPunct('(')) this.fail(`Expected '(' after '${t.value}'.`);
    const close = findClosing(this.tokens, this.pos);
    if (close === -1) this.fail(`Unterminated '${t.value}(...)'.`);
    const inner = this.tokens.slice(this.pos + 1, close);
    this.pos = close + 1;

    if (t.value === 'alignas' || t.value === '_Alignas') {
      attrs.aligned = this.alignRequestFrom(inner, t);
      return;
    }
    if (t.value === '__declspec') {
      // __declspec(align(n)); other declspecs (dllexport, novtable...) have no layout effect.
      for (let i = 0; i < inner.length; i++) {
        if (inner[i].value === 'align' && inner[i + 1]?.value === '(') {
          const end = findClosing(inner, i + 1);
          attrs.aligned = this.evaluate(inner.slice(i + 2, end), 'Alignment', t.line);
        }
      }
      return;
    }
    // __attribute__((a, b(args), ...)): the outer parens wrap one more pair.
    const list = inner[0]?.value === '(' ? inner.slice(1, findClosing(inner, 0)) : inner;
    for (let i = 0; i < list.length; ) {
      const nameTok = list[i];
      if (nameTok.kind !== 'id') {
        i += 1;
        continue;
      }
      const name = nameTok.value.replace(/^__(.*)__$/, '$1');
      let args: Token[] = [];
      let j = i + 1;
      if (list[j]?.value === '(') {
        const end = findClosing(list, j);
        args = list.slice(j + 1, end);
        j = end + 1;
      }
      if (name === 'packed') attrs.packed = true;
      else if (name === 'aligned') {
        attrs.aligned = args.length === 0 ? 'max' : this.evaluate(args, 'Alignment', nameTok.line);
      } else if (UNMODELLED_LAYOUT_ATTRIBUTES.has(name)) {
        this.warnings.push({ message: `__attribute__((${name})) changes layout and is not modelled.`, line: nameTok.line, type: 'warning' });
      }
      i = list[j]?.value === ',' ? j + 1 : j;
    }
  }

  /** C++11 / C23 [[...]] attributes. Only [[no_unique_address]] affects layout. */
  private parseStdAttributes(attrs: Attributes): void {
    const close = findClosing(this.tokens, this.pos);
    const inner = this.tokens.slice(this.pos + 2, close - 1);
    this.pos = close + 1;
    if (inner.some((t) => t.value === 'no_unique_address' || t.value === 'msvc::no_unique_address')) {
      this.warnings.push({ message: '[[no_unique_address]] is not modelled: the member is laid out normally.', line: inner[0]?.line, type: 'warning' });
    }
    void attrs;
  }

  /** `alignas(type)` (the type's alignment) or `alignas(constant-expression)`. */
  private alignRequestFrom(inner: Token[], at: Token): AlignRequest {
    const parsed = this.oracle.typeName(inner, 0);
    if (parsed && parsed.end === inner.length) {
      try {
        return { ofType: this.oracle.describe(parsed.type), alignment: this.oracle.alignOf(parsed.type, false) };
      } catch (err) {
        if (!(err instanceof ConstExprError)) throw err;
        this.fail(`alignas(${inner.map((t) => t.value).join(' ')}): ${err.message}.`, at.line);
      }
    }
    return this.evaluate(inner, 'Alignment', at.line);
  }

  // ------------------------------------------------------------------ declarators

  /**
   * Parse one declarator. Derivations are collected from the name outward, following C's
   * precedence: suffixes ([] and ()) bind tighter than a prefix '*'.
   */
  private parseDeclarator(allowAbstract: boolean): Declarator {
    const line = this.currentLine();
    const attrs: Attributes = {};
    let pointers = 0;
    for (;;) {
      if (this.isPunct('*') || this.isPunct('&') || this.isPunct('&&') || this.isPunct('^')) {
        pointers += 1;
        this.pos += 1;
        continue;
      }
      const t = this.peek();
      if (t?.kind === 'id' && QUALIFIERS.has(t.value)) {
        this.pos += 1;
        continue;
      }
      if (t?.kind === 'id' && (t.value === '__attribute__' || t.value === '__attribute')) {
        this.parseAttribute(attrs);
        continue;
      }
      break;
    }

    let inner: Declarator = { derivations: [], attrs: {}, line };
    if (this.isPunct('(') && (this.isPunct('*', 1) || this.isPunct('&', 1) || this.isPunct('^', 1) || this.isPunct('(', 1))) {
      this.pos += 1;
      inner = this.parseDeclarator(allowAbstract);
      this.expectPunct(')', 'to close the parenthesized declarator');
    } else if (this.peek()?.kind === 'id' && !KEYWORDS.has(this.peek()!.value)) {
      inner.name = this.peek()!.value;
      this.pos += 1;
      // C++ out-of-line names (A::b) and operator names are not members; keep the last part.
      while (this.isPunct('::') && this.peek(1)?.kind === 'id') {
        inner.name = this.peek(1)!.value;
        this.pos += 2;
      }
    } else if (this.isId('operator')) {
      inner.name = 'operator';
      this.pos += 1;
      this.takeUntil(['(']);
    } else if (!allowAbstract) {
      const found = this.peek();
      this.fail(`Expected a member name${found ? ` but found '${found.value}'` : ''}.`);
    }

    const suffixes: Derivation[] = [];
    for (;;) {
      if (this.isPunct('[') && !this.isPunct('[', 1)) {
        const close = findClosing(this.tokens, this.pos);
        if (close === -1) this.fail("Missing ']' in array declarator.");
        const sizeTokens = this.tokens.slice(this.pos + 1, close);
        this.pos = close + 1;
        if (sizeTokens.length === 0) {
          suffixes.push({ kind: 'array', size: null });
        } else {
          const size = this.evaluate(sizeTokens, 'Array size', line);
          if (size < 0) this.fail(`Array size ${size} of '${inner.name ?? 'member'}' is negative.`, line);
          suffixes.push({ kind: 'array', size });
        }
        continue;
      }
      if (this.isPunct('(')) {
        const close = findClosing(this.tokens, this.pos);
        if (close === -1) this.fail("Missing ')' in function declarator.");
        const params = this.tokens.slice(this.pos + 1, close).map((t) => t.value).join(' ').replace(/ ([,)])/g, '$1');
        this.pos = close + 1;
        suffixes.push({ kind: 'func', params });
        // Trailing method qualifiers and specifiers.
        while (this.peek()?.kind === 'id' && ['const', 'volatile', 'override', 'final', 'noexcept', 'throw'].includes(this.peek()!.value)) {
          this.pos += 1;
          if (this.isPunct('(')) this.pos = findClosing(this.tokens, this.pos) + 1;
        }
        if (this.isPunct('->')) {
          this.pos += 1;
          this.takeUntil([';', '{', '=', ',']);
        }
        continue;
      }
      break;
    }
    this.parseAttributes(attrs);

    const result: Declarator = {
      name: inner.name,
      derivations: [...inner.derivations, ...suffixes, ...Array.from({ length: pointers }, () => ({ kind: 'ptr' as const }))],
      attrs: { ...inner.attrs, ...attrs },
      line,
    };

    if (this.isPunct(':')) {
      this.pos += 1;
      const start = this.pos;
      let widthTokens = this.takeUntil([',', ';', '=', '}', '{']);
      // The width ends where attributes begin: `int b : 4 __attribute__((aligned(8)));`.
      const attribute = widthTokens.findIndex(
        (t, i) => (t.kind === 'id' && ATTRIBUTE_KEYWORDS.includes(t.value))
          || (t.kind === 'punct' && t.value === '[' && widthTokens[i + 1]?.value === '['),
      );
      if (attribute >= 0) {
        widthTokens = widthTokens.slice(0, attribute);
        this.pos = start + attribute;
      }
      result.bitWidth = this.evaluate(widthTokens, 'Bit-field width', line);
      if (result.bitWidth < 0) this.fail(`Bit-field width ${result.bitWidth} is negative.`, line);
      if (result.bitWidth === 0 && result.name) {
        this.fail(`Zero-width bit-field '${result.name}' must be unnamed.`, line);
      }
    }
    this.parseAttributes(result.attrs);
    return result;
  }

  // ------------------------------------------------------------------ types

  private baseTypeInfo(spec: Specifiers): TypeInfo {
    const base = spec.base!;
    switch (base.kind) {
      case 'builtin':
        return { type: canonicalBuiltin(base.words), isPointer: false, dims: [] };
      case 'record': {
        const name = base.def?.name ?? base.tag ?? '';
        return {
          type: `${base.keyword} ${name}`,
          isPointer: false,
          dims: [],
          recordRef: { keyword: base.keyword, name },
          nestedStruct: base.def,
        };
      }
      case 'enum': {
        const name = base.def?.name ?? base.tag ?? '';
        return { type: `enum ${name}`, isPointer: false, dims: [], enumRef: name, enumType: base.def };
      }
      case 'name': {
        const alias = this.typeAliases.get(base.name);
        if (alias) return { ...alias, dims: [...alias.dims] };
        const aligned = this.aliasAlignments.get(base.name);
        const typeAlignment = aligned !== undefined ? { typeAlignment: aligned } : {};
        if (this.structAliases.has(base.name) || this.structs.has(base.name) || this.unions.has(base.name)) {
          return { type: base.name, isPointer: false, dims: [], recordRef: { keyword: 'struct', name: base.name }, ...typeAlignment };
        }
        if (this.enumAliases.has(base.name) || this.enums.has(base.name)) {
          return { type: base.name, isPointer: false, dims: [], enumRef: base.name, ...typeAlignment };
        }
        return { type: base.name, isPointer: false, dims: [] };
      }
    }
  }

  /** Apply a declarator's derivations to a base type. */
  private applyDeclarator(base: TypeInfo, decl: Declarator, name: string): TypeInfo {
    const d = decl.derivations;
    const dims: number[] = [];
    let i = 0;
    while (d[i]?.kind === 'array') {
      const size = (d[i] as { size: number | null }).size;
      if (size === null && i > 0) {
        this.fail(`Only the first dimension of '${name}' may be left empty.`, decl.line);
      }
      dims.push(size ?? 0);
      i += 1;
    }
    const rest = d.slice(i);

    if (rest.length === 0) {
      // An array of the type, which may itself be an array (or an array of pointers) by typedef.
      return { ...base, dims: [...dims, ...base.dims] };
    }
    if (rest[0].kind === 'func') {
      this.fail(`'${name}' is declared as a function returning ${base.type}; only pointers to functions can be members.`, decl.line);
    }
    // Pointer (to anything, including arrays and functions): the member stores an address.
    const func = rest.find((x): x is Extract<Derivation, { kind: 'func' }> => x.kind === 'func');
    // One '*' per pointer level before any function/array derivation: char** stays char**.
    let levels = 0;
    while (rest[levels]?.kind === 'ptr') levels += 1;
    // One pointer straight onto a function; a pointer to a function pointer points at data.
    const functionPointer = levels === 1 && rest[1]?.kind === 'func';
    return {
      type: `${base.type}${'*'.repeat(Math.max(1, levels))}`,
      declaredType: func ? `${base.declaredType ?? base.type} (*)(${func.params})` : base.declaredType ? `${base.declaredType}*` : undefined,
      isPointer: true,
      ...(functionPointer && { functionPointer: true }),
      ...(!functionPointer && { pointee: this.applyDeclarator(base, { ...decl, derivations: rest.slice(1) }, name) }),
      dims,
    };
  }

  // ------------------------------------------------------------------ bodies

  private parseBody(close: number, ownerName: string, owner: ParsedStruct): StructMember[] {
    const members: StructMember[] = [];
    const seen = new Set<string>();
    let warnedVirtual = false;

    while (this.pos < close) {
      const start = this.pos;
      try {
        const t = this.peek()!;
        if (t.kind === 'punct' && t.value === ';') {
          this.pos += 1;
          continue;
        }
        // C++ access labels.
        if (t.kind === 'id' && ['public', 'private', 'protected'].includes(t.value) && this.isPunct(':', 1)) {
          this.pos += 2;
          continue;
        }
        if (t.kind === 'id' && (t.value === 'static_assert' || t.value === '_Static_assert')) {
          this.checkStaticAssert();
          continue;
        }
        if (t.kind === 'id' && ['using', 'template', 'friend'].includes(t.value)) {
          this.skipMember(close);
          continue;
        }

        const spec = this.parseSpecifiers(ownerName, false);
        if (!spec.base) {
          // Constructors and destructors: Name(...) or ~Name(...).
          if ((t.kind === 'id' && this.isPunct('(', 1)) || (t.value === '~')) {
            this.skipMember(close);
            continue;
          }
          this.fail(`Unexpected '${t.value}' in member declaration of '${ownerName}'.`, t.line);
        }

        if (spec.isTypedef) {
          // Member typedef (C++): declares a type name, takes no space.
          for (;;) {
            const decl = this.parseDeclarator(false);
            if (decl.name) this.registerTypedef(spec, decl);
            if (this.isPunct(',')) { this.pos += 1; continue; }
            break;
          }
          this.endMember(close, ownerName, undefined);
          continue;
        }

        if (this.isPunct(';') || this.pos >= close) {
          // No declarator: a C11 anonymous struct/union member, or just a nested type declaration.
          if (spec.base!.kind === 'record' && spec.base!.def && !spec.base!.tag) {
            members.push({
              name: '',
              type: `${spec.base!.keyword} ${spec.base!.def.name}`,
              isNested: true,
              nestedStruct: spec.base!.def,
              line: spec.line,
            });
          } else if (spec.base!.kind !== 'record' && spec.base!.kind !== 'enum') {
            this.warnings.push({ message: `Declaration in '${ownerName}' does not declare a member.`, line: spec.line, type: 'warning' });
          }
          this.endMember(close, ownerName, undefined);
          continue;
        }

        let lastName: string | undefined;
        for (;;) {
          const decl = this.parseDeclarator(true);
          lastName = decl.name ?? lastName;
          const isFunction = decl.derivations[0]?.kind === 'func';

          if (isFunction) {
            if (spec.isVirtual && !warnedVirtual) {
              warnedVirtual = true;
              this.warnings.push({
                message: `'${ownerName}' has virtual functions: the hidden vtable pointer is not included in this layout.`,
                line: decl.line,
                type: 'warning',
              });
            }
            // Inline method body, pure-virtual "= 0", "= default" / "= delete".
            if (this.isPunct('{')) {
              this.pos = findClosing(this.tokens, this.pos) + 1;
              lastName = undefined;
              break;
            }
            if (this.isPunct('=')) { this.pos += 1; this.takeUntil([',', ';']); }
          } else if (!spec.isStatic && !spec.isFriend) {
            const member = this.buildMember(spec, decl, ownerName);
            if (member) {
              if (member.name && seen.has(member.name)) {
                this.errors.push({
                  message: `Duplicate member name '${member.name}' in struct '${ownerName}'. Member names must be unique.`,
                  line: decl.line,
                  type: 'semantic',
                });
              } else {
                if (member.name) seen.add(member.name);
                members.push(member);
              }
            }
          }

          // Default member initializer (C++): `= expr` or `{ ... }`.
          if (this.isPunct('=')) { this.pos += 1; this.takeUntil([',', ';']); }
          else if (this.isPunct('{')) { this.pos = findClosing(this.tokens, this.pos) + 1; }

          if (this.isPunct(',')) { this.pos += 1; continue; }
          break;
        }
        if (lastName === undefined && !this.isPunct(';')) continue; // method with a body: no ';'
        this.endMember(close, ownerName, lastName);
      } catch (err) {
        if (!(err instanceof Recover)) throw err;
        this.skipMember(close);
      }
      if (this.pos === start) this.pos += 1;
    }

    // A flexible array member is only valid last, and only in a struct.
    members.forEach((m, i) => {
      if (m.arraySize === 0 && m.arrayDims?.[0] === 0) {
        if (owner.isUnion) {
          this.errors.push({ message: `Flexible array member '${m.name}' is not allowed in union '${ownerName}'.`, line: m.line, type: 'semantic' });
        } else if (i !== members.length - 1) {
          this.errors.push({ message: `Flexible array member '${m.name}' must be the last member of '${ownerName}'.`, line: m.line, type: 'semantic' });
        }
      }
    });

    return members;
  }

  private endMember(close: number, ownerName: string, memberName: string | undefined): void {
    if (this.isPunct(';')) {
      this.pos += 1;
      return;
    }
    const what = memberName ? `member '${memberName}'` : 'the declaration';
    if (this.pos >= close) {
      this.fail(`Missing semicolon after ${what} in '${ownerName}'.`);
    }
    this.fail(`Expected ';' after ${what} in '${ownerName}' but found '${this.peek()!.value}'.`);
  }

  private skipMember(close: number): void {
    while (this.pos < close) {
      const t = this.tokens[this.pos];
      if (t.kind === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{')) {
        const end = findClosing(this.tokens, this.pos);
        this.pos = end === -1 || end > close ? close : end + 1;
        if (t.value === '{' && !this.isPunct(';')) return; // method body ends the member
        continue;
      }
      this.pos += 1;
      if (t.kind === 'punct' && t.value === ';') return;
    }
  }

  private buildMember(spec: Specifiers, decl: Declarator, ownerName: string): StructMember | null {
    const name = decl.name ?? '';
    if (!decl.name && decl.bitWidth === undefined) {
      this.warnings.push({ message: `Unnamed declaration in '${ownerName}' does not declare a member.`, line: decl.line, type: 'warning' });
      return null;
    }
    const base = this.baseTypeInfo(spec);
    const info = this.applyDeclarator(base, decl, name || 'bit-field');

    const member = this.memberOfType(info, name, false);
    member.line = decl.line;
    const declared = spec.base!.kind === 'name' ? (info.isPointer ? info.declaredType ?? undefined : spec.base!.name) : info.declaredType;
    if (declared && declared !== info.type) member.declaredType = declared;

    if (decl.bitWidth !== undefined) {
      if (info.dims.length > 0 || info.isPointer) {
        this.fail(`Bit-field '${name || '(unnamed)'}' must have an integer type.`, decl.line);
      }
      member.bitField = decl.bitWidth;
    }

    const aligned = decl.attrs.aligned ?? spec.attrs.aligned;
    if (aligned !== undefined) member.alignAttribute = aligned;
    if (decl.attrs.packed || spec.attrs.packed) member.packed = true;
    return member;
  }

  /**
   * A member of type `info`. Records and enums are linked to their definitions now when `resolve`
   * is set, as measuring needs; members are linked at the end (resolveReferences), so a typedef
   * may name a record defined after it.
   */
  private memberOfType(info: TypeInfo, name: string, resolve: boolean): StructMember {
    const member: StructMember = { name, type: info.type };
    if (info.functionPointer) member.functionPointer = true;
    if (info.dims.length > 0) {
      member.arrayDims = info.dims;
      member.arraySize = info.dims.reduce((a, b) => a * b, 1);
    }
    if (!info.isPointer) {
      if (info.recordRef) {
        member.isNested = true;
        const def = info.nestedStruct ?? (resolve ? this.resolveStructTypeByName(info.recordRef.name) : undefined);
        if (def) member.nestedStruct = def;
      }
      if (info.enumRef !== undefined) {
        const enumType = info.enumType ?? this.resolveEnumTypeByName(info.enumRef);
        if (enumType) member.enumType = enumType;
      }
      // A pointer to an aligned typedef is an ordinary pointer.
      if (info.typeAlignment !== undefined) member.typeAlignment = info.typeAlignment;
    }
    return member;
  }

  /** The type of a laid-out member, to go on from it in `offsetof(T, a.b[2])`. */
  private typeOfMember(m: StructMember): TypeInfo {
    const isPointer = m.type.includes('*');
    return {
      type: m.type,
      ...(m.declaredType !== undefined && { declaredType: m.declaredType }),
      isPointer,
      ...(m.functionPointer && { functionPointer: true }),
      dims: m.arrayDims ?? [],
      ...(!isPointer && m.isNested && { recordRef: { keyword: m.nestedStruct?.isUnion ? 'union' as const : 'struct' as const, name: m.nestedStruct?.name ?? m.type.replace(/^(struct|union)\s+/, '') } }),
      ...(m.nestedStruct && { nestedStruct: m.nestedStruct }),
      ...(m.enumType && { enumRef: m.enumType.name, enumType: m.enumType }),
      ...(m.typeAlignment !== undefined && { typeAlignment: m.typeAlignment }),
    };
  }

  // ------------------------------------------------------------------ types in constant expressions

  /** Whether `t` can start a type-name: a type keyword or qualifier, or a name declared as a type. */
  private startsTypeName(t: Token | undefined): boolean {
    if (t?.kind !== 'id') return false;
    const v = t.value;
    return (
      BUILTIN_WORDS.has(v) ||
      TYPE_NAME_QUALIFIERS.has(v) ||
      v === 'struct' || v === 'union' || v === 'enum' || v === 'class' ||
      STANDARD_TYPEDEFS.has(v) ||
      this.typeAliases.has(v) || this.structAliases.has(v) || this.enumAliases.has(v) ||
      // C++: a class or enum is a type name without its keyword.
      this.structs.has(v) || this.unions.has(v) || this.enums.has(v)
    );
  }

  /** A record or enum type that has no definition yet, which `sizeof` and friends cannot measure. */
  private requireComplete(info: TypeInfo): void {
    if (info.isPointer) return;
    if (info.dims.includes(0)) throw new ConstExprError(`'${this.describeType(info)}' is an array of unknown size`);
    if (info.type === 'void') throw new ConstExprError("'void' has no size");
    if (info.recordRef && !(info.nestedStruct ?? this.resolveStructTypeByName(info.recordRef.name))) {
      throw new ConstExprError(`'${this.describeType(info)}' is incomplete here: it has no definition before this point`);
    }
    if (info.enumRef !== undefined && !(info.enumType ?? this.resolveEnumTypeByName(info.enumRef))) {
      throw new ConstExprError(`'${this.describeType(info)}' is incomplete here: it has no definition before this point`);
    }
  }

  /** The type measured as it is so far: records defined before this point, linked to their members. */
  private measurable(info: TypeInfo): StructMember {
    this.requireComplete(info);
    this.resolveReferences();
    return this.memberOfType(info, '', true);
  }

  private describeType(info: TypeInfo): string {
    return info.dims.length > 0 ? `${info.declaredType ?? info.type}[${info.dims.join('][')}]` : info.declaredType ?? info.type;
  }

  /** Whether a value of the integer type is signed: undefined where the target decides and it is not modelled. */
  private signedness(info: TypeInfo): 'signed' | 'unsigned' | undefined {
    if (info.enumType || info.enumRef !== undefined) return undefined;
    const type = info.type;
    if (type.startsWith('unsigned ') || ['char8_t', 'char16_t', 'char32_t'].includes(type)) return 'unsigned';
    if (['signed char', 'short', 'int', 'long', 'long long', '__int128'].includes(type)) return 'signed';
    return STANDARD_TYPEDEFS.get(type);
  }

  private createOracle(): TypeOracle<TypeInfo> {
    return {
      typeName: (tokens, start) => {
        if (!this.startsTypeName(tokens[start])) return undefined;
        const savedTokens = this.tokens;
        const savedPos = this.pos;
        this.tokens = tokens as Token[];
        this.pos = start;
        try {
          const spec = this.parseSpecifiers(null, false);
          if (!spec.base || spec.isTypedef || spec.isStatic) return undefined;
          const decl = this.parseDeclarator(true);
          if (decl.name !== undefined || decl.bitWidth !== undefined) return undefined;
          return { type: this.applyDeclarator(this.baseTypeInfo(spec), decl, 'type name'), end: this.pos };
        } finally {
          this.tokens = savedTokens;
          this.pos = savedPos;
        }
      },
      sizeOf: (info) => this.calculator.measure(this.measurable(info)).size,
      alignOf: (info, preferred) => {
        const member = this.measurable(info);
        return preferred ? this.calculator.preferredAlignment(member) : this.calculator.measure(member).alignment;
      },
      member: (info, name) => {
        const def = info.isPointer || info.dims.length > 0 || !info.recordRef ? undefined : info.nestedStruct ?? this.resolveStructTypeByName(info.recordRef.name);
        if (!def) {
          if (info.recordRef && !info.isPointer && info.dims.length === 0) this.requireComplete(info);
          throw new ConstExprError(`'${name}' is looked up in '${this.describeType(info)}', which is not a struct or union`);
        }
        this.resolveReferences();
        const found = findLaidOutMember(this.calculator.calculate(def), name);
        if (!found) throw new ConstExprError(`'${this.describeType(info)}' has no member '${name}'`);
        if (found.member.bitField !== undefined) throw new ConstExprError(`'${name}' is a bit-field, which has no address`);
        return { offset: found.offset, type: this.typeOfMember(found.member) };
      },
      element: (info) => (info.dims.length > 0 ? { ...info, dims: info.dims.slice(1) } : info.isPointer ? info.pointee : undefined),
      isArray: (info) => info.dims.length > 0,
      isPointer: (info) => info.isPointer && info.dims.length === 0,
      convert: (info, value) => {
        if (info.isPointer || info.dims.length > 0 || info.recordRef) {
          throw new ConstExprError(`a cast to '${this.describeType(info)}' does not give an integer`);
        }
        if (/\b(float|double)\b/.test(info.type)) throw new ConstExprError(`'${this.describeType(info)}' is not an integer type`);
        if (info.type === '_Bool' || info.type === 'bool') return value ? 1 : 0;
        // Exact for 64-bit types, where doubles would round.
        const bits = 8 * this.calculator.measure(this.measurable(info)).size;
        const exact = BigInt(Math.trunc(value));
        const asUnsigned = Number(BigInt.asUintN(bits, exact));
        const asSigned = Number(BigInt.asIntN(bits, exact));
        const signedness = this.signedness(info);
        if (signedness === 'unsigned') return asUnsigned;
        if (signedness === 'signed') return asSigned;
        if (asUnsigned !== asSigned) {
          throw new ConstExprError(`converting ${value} to '${this.describeType(info)}' depends on whether that type is signed on this target, which is not modelled`);
        }
        return asUnsigned;
      },
      describe: (info) => this.describeType(info),
    };
  }

  // ------------------------------------------------------------------ resolution

  /** Link record and enum references (forward references and typedef names) to definitions. */
  private resolveReferences(): void {
    const visit = (members: StructMember[]) => {
      for (const m of members) {
        if (m.isNested && !m.nestedStruct) {
          const name = m.type.replace(/^(struct|union)\s+/, '').trim();
          const resolved = this.resolveStructTypeByName(name);
          if (resolved) m.nestedStruct = resolved;
        }
        if (!m.enumType && !m.type.includes('*')) {
          if (m.type.startsWith('enum ')) {
            const e = this.resolveEnumTypeByName(m.type.slice(5).trim());
            if (e) m.enumType = e;
          } else if (this.enumAliases.has(m.type) || this.enums.has(m.type)) {
            const e = this.resolveEnumTypeByName(m.type);
            if (e) m.enumType = e;
          }
        }
      }
    };
    for (const s of this.structs.values()) visit(s.members);
    for (const u of this.unions.values()) visit(u.members);
  }

  private createAnonymousTypeName(kind: string, parentName: string): string {
    const base = parentName.replace(/\W+/g, '_');
    this.anonymousTypeCounter += 1;
    return `__anon_${kind}_${base}_${this.anonymousTypeCounter}`;
  }

  // ------------------------------------------------------------------ public API

  getStructs(): Map<string, ParsedStruct> {
    return this.structs;
  }

  getStruct(name: string): ParsedStruct | undefined {
    return this.structs.get(name);
  }

  getAllStructs(): ParsedStruct[] {
    return Array.from(this.structs.values());
  }

  getAllUnions(): ParsedStruct[] {
    return Array.from(this.unions.values());
  }

  getLastDefinition(): ParsedStruct | undefined {
    if (this.definitionOrder.length === 0) return undefined;
    const last = this.definitionOrder[this.definitionOrder.length - 1];
    return last.isUnion ? this.unions.get(last.name) : this.structs.get(last.name);
  }

  getUnion(name: string): ParsedStruct | undefined {
    return this.unions.get(name);
  }

  getEnum(name: string): ParsedEnum | undefined {
    return this.enums.get(name);
  }

  getAllEnums(): ParsedEnum[] {
    return Array.from(this.enums.values());
  }

  /** Scalar typedefs, e.g. `typedef unsigned int u32;` maps 'u32' to 'unsigned int'. */
  getTypeAliases(): ReadonlyMap<string, { type: string }> {
    return this.typeAliases;
  }

  private resolveEnumTypeByName(name: string): ParsedEnum | undefined {
    if (!name) return undefined;
    return this.enums.get(name) ?? this.enums.get(this.enumAliases.get(name) ?? '');
  }

  /** The struct or union a tag or typedef name refers to. */
  resolveRecord(name: string): ParsedStruct | undefined {
    return this.resolveStructTypeByName(name);
  }

  private resolveStructTypeByName(name: string): ParsedStruct | undefined {
    if (!name) return undefined;
    const direct = this.structs.get(name) || this.unions.get(name);
    if (direct) return direct;
    const alias = this.structAliases.get(name);
    return alias ? this.structs.get(alias) || this.unions.get(alias) : undefined;
  }

  isUnion(name: string): boolean {
    return this.unions.has(name);
  }

  isStruct(name: string): boolean {
    return this.structs.has(name);
  }
}

/**
 * Member `name` of a laid-out record and its offset, looking inside anonymous struct and union
 * members, whose members belong to the enclosing record (C11 6.7.2.1p13).
 */
function findLaidOutMember(layout: CalculationResult, name: string): { member: StructMember; offset: number } | undefined {
  for (const m of layout.members) {
    if (m.member.name === name) return { member: m.member, offset: m.offset };
    if (m.member.name === '' && m.nested) {
      const inner = findLaidOutMember(m.nested, name);
      if (inner) return { member: inner.member, offset: m.offset + inner.offset };
    }
  }
  return undefined;
}

/** Normalize builtin type words to the names used by the type tables ("short int" -> "short"). */
function canonicalBuiltin(words: readonly string[]): string {
  const has = (w: string) => words.includes(w);
  const longs = words.filter((w) => w === 'long').length;
  const unsigned = has('unsigned');
  const signed = has('signed');
  if (has('void')) return 'void';
  if (has('_Bool')) return '_Bool';
  if (has('bool')) return 'bool';
  for (const w of ['wchar_t', 'char8_t', 'char16_t', 'char32_t']) if (has(w)) return w;
  if (has('__int128')) return unsigned ? 'unsigned __int128' : '__int128';
  if (has('float')) return has('_Complex') ? 'float _Complex' : 'float';
  if (has('double')) return `${longs > 0 ? 'long double' : 'double'}${has('_Complex') ? ' _Complex' : ''}`;
  if (has('char')) return unsigned ? 'unsigned char' : signed ? 'signed char' : 'char';
  const base = has('short') ? 'short' : longs >= 2 ? 'long long' : longs === 1 ? 'long' : 'int';
  return unsigned ? `unsigned ${base}` : base;
}
