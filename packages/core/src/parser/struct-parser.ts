import type {
  AlignRequest,
  Architecture,
  CalculationResult,
  CppBase,
  EnumMember,
  MsInheritanceModel,
  SourceLanguage,
  ParseError,
  ParsedEnum,
  ParsedStruct,
  StructMember,
  ValidationResult,
} from '../types';
import type { DataModel } from '../abi/data-models';
import { PaddingCalculator } from '../layout/padding-calculator';
import { msInheritanceModel } from '../layout/cpp-layout';
import { dataModels } from '../abi/data-models';
import { ConstExprError, evaluateConstExpr, evaluateIntegerConstExpr, expressionType, integerType } from './const-expr';
import type { ConstantValue, ConstExprContext, IntegerModel, IntType, ScalarType, TypeOracle } from './const-expr';
import { packAt, preprocess } from './preprocess';
import type { Preprocessed } from './preprocess';
import { MAX_NESTING, Nesting, NestingError } from '../nesting';
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
  /** C unless given. C++ constructs are an error in C, as they are for a C compiler. */
  language?: SourceLanguage;
}

/** The <stddef.h>, <stdint.h> and <stdbool.h> typedef names, which are built in like the headers. */
const STANDARD_TYPEDEFS: ReadonlyMap<string, 'signed' | 'unsigned'> = new Map([
  ['int8_t', 'signed'], ['int16_t', 'signed'], ['int32_t', 'signed'], ['int64_t', 'signed'],
  ['uint8_t', 'unsigned'], ['uint16_t', 'unsigned'], ['uint32_t', 'unsigned'], ['uint64_t', 'unsigned'],
  ['intptr_t', 'signed'], ['uintptr_t', 'unsigned'], ['ptrdiff_t', 'signed'], ['size_t', 'unsigned'],
  ['ssize_t', 'signed'],
]);
/** GCC's typedef names for __int128, built in on the targets that have the type. */
const INT128_TYPEDEFS: ReadonlyMap<string, 'signed' | 'unsigned'> = new Map([['__int128_t', 'signed'], ['__uint128_t', 'unsigned']]);

const QUALIFIERS = new Set([
  'const', 'volatile', 'restrict', '__restrict', '__restrict__', '_Atomic', 'mutable', 'register',
  'auto', 'inline', '__inline', '__inline__', 'explicit', 'extern', 'thread_local', '_Thread_local',
  '__thread', '__extension__', '_Noreturn',
]);
/** Specifiers C does not have. */
const CPP_ONLY_SPECIFIERS = new Set(['virtual', 'friend', 'explicit', 'mutable', 'consteval', 'constinit', 'typename', 'class']);
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
/** Keywords that start an attribute or alignment specifier (`[[...]]` is handled separately). */
const ATTRIBUTE_KEYWORDS: readonly string[] = ['__attribute__', '__attribute', '__declspec', 'alignas', '_Alignas', '__packed'];
/** GNU attributes that change layout but are not modelled; anything else has no layout effect. */
const UNMODELLED_LAYOUT_ATTRIBUTES = new Set(['mode', 'vector_size', 'ms_struct', 'gcc_struct', 'scalar_storage_order', 'designated_init']);

interface Attributes {
  packed?: boolean;
  /** `aligned` attributes and alignas specifiers: the strictest of them counts (GCC, MSVC). */
  aligned?: AlignRequest;
  /** `__declspec(align(n))`: MSVC keeps the last one, then the stricter of it and `aligned`. */
  declspecAlign?: AlignRequest;
  noUniqueAddress?: 'std' | 'msvc';
  /** `__declspec(empty_bases)`. */
  emptyBases?: boolean;
}

type RecordKeyword = 'struct' | 'union';

/** What the declaration specifiers name as the base type. */
type BaseSpec =
  | { kind: 'builtin'; words: string[] }
  | { kind: 'name'; name: string }
  | { kind: 'record'; keyword: RecordKeyword; tag?: string; def?: ParsedStruct }
  | { kind: 'enum'; tag?: string; def?: ParsedEnum }
  /** `typeof(...)` / `__typeof__(...)`: the type of a type-name or of an expression. */
  | { kind: 'typeof'; type: TypeInfo; spelled: string };

interface Specifiers {
  base?: BaseSpec;
  isTypedef: boolean;
  isStatic: boolean;
  isVirtual: boolean;
  isFriend: boolean;
  isExplicit: boolean;
  /** `const` or `volatile` among the specifiers. */
  cv: string[];
  attrs: Attributes;
  line: number;
  /** The specifiers as written, for display (e.g. "const char"). */
  written: string;
}

type Derivation =
  /**
   * A pointer, a C++ reference (`&`, `&&`), or a C++ pointer to a member of class `memberOf`
   * (`A::*`); `cv` are the qualifiers written after it.
   */
  | { kind: 'ptr'; ref?: '&' | '&&'; memberOf?: string; cv?: string[] }
  | { kind: 'array'; size: number | null }
  /** `quals`: what follows the parameters: const, volatile, &, &&, override, final, noexcept. */
  | { kind: 'func'; params: string; paramTokens: Token[]; quals: string[] };

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
  /** The first dimension was left empty: a flexible array member (dims[0] is 0). */
  flexible?: boolean;
  recordRef?: { keyword: RecordKeyword; name: string };
  nestedStruct?: ParsedStruct;
  enumRef?: string;
  enumType?: ParsedEnum;
  /** Set by an aligned typedef: the type's own alignment (see StructMember.typeAlignment). */
  typeAlignment?: AlignRequest;
  /** For a data pointer: what it points to, for `->` and `*` in constant expressions. */
  pointee?: TypeInfo;
  /** A C++ pointer to member (StructMember.memberPointer), whose class is looked at where it is used. */
  memberPointer?: { className: string; function: boolean };
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
  /** Every name declared by a typedef, including `typedef struct S S;`. */
  private typedefNames: Set<string> = new Set();
  /** What each typedef stands for, spelled as spellType spells types, to compare signatures. */
  private typedefSpellings: Map<string, string> = new Map();
  /** Alignment set by an aligned typedef of a struct, union or enum, by alias name. */
  private aliasAlignments: Map<string, AlignRequest> = new Map();
  private enumConstants: Map<string, ConstantValue> = new Map();
  private definitionOrder: Array<{ name: string; isUnion: boolean }> = [];
  private anonymousTypeCounter = 0;
  /** C++: the classes whose bodies are being parsed, innermost last. */
  private defining: ParsedStruct[] = [];
  /** C++: classes a pointer to member named before they were defined (MSVC's 'unspecified'). */
  private usedIncomplete: Set<string> = new Set();
  private pre: Preprocessed | null = null;
  private tokens: Token[] = [];
  private pos = 0;
  /** How deeply nested what is being parsed is, its constant expressions included. */
  private nesting = new Nesting();
  /** Measures types for `sizeof` and friends, with the definitions parsed so far. */
  private readonly calculator: PaddingCalculator;
  private readonly oracle: TypeOracle<TypeInfo>;
  /** The target's integer types and its compiler's constant folding. */
  private readonly integers: IntegerModel;

  constructor(private readonly target: ParserTarget) {
    this.calculator = new PaddingCalculator(target.architecture, target.dataModel);
    this.oracle = this.createOracle();
    this.integers = this.integerModel();
  }

  /** Whether the target has GCC's __int128 (its type tables say so: data-models.ts). */
  private get hasInt128(): boolean {
    return this.target.architecture.dataTypes?.['__int128'] !== undefined;
  }

  /** The compiler the target's rules are measured on, which bitfieldLayout names. */
  private get compiler(): 'gcc' | 'msvc' | 'sdcc' {
    const rules = this.target.architecture.bitfieldLayout;
    return rules === 'ms' ? 'msvc' : rules === 'sdcc' ? 'sdcc' : 'gcc';
  }

  private integerModel(): IntegerModel {
    const types = dataModels[this.target.dataModel].dataTypes;
    const bytes = (type: string) => this.calculator.measure({ name: '', type }).size;
    const pointer = this.target.architecture.pointerSize ?? types.pointerSize;
    // size_t is the unsigned type of a pointer's size (SDCC's 3-byte generic pointers aside:
    // its size_t is unsigned int, and its folding gives sizeof its own type anyway).
    const sizeType = (['unsigned int', 'unsigned long', 'unsigned long long'] as const).find((t) => bytes(t) === pointer) ?? 'unsigned int';
    return {
      short: 8 * types.shortSize,
      int: 8 * types.intSize,
      long: 8 * types.longSize,
      longLong: 8 * types.longLongSize,
      charSigned: this.target.architecture.charSigned,
      sizeType,
      floatBytes: { float: bytes('float'), double: bytes('double'), 'long double': this.compiler === 'sdcc' ? bytes('double') : bytes('long double') },
      // GCC: no constant (measured with every gcc here); SDCC and MSVC fold to the wrapped value.
      overflow: this.compiler === 'gcc' ? 'not-constant' : 'wrap',
      folding: this.compiler === 'sdcc' ? 'sdcc' : 'iso',
      ...(this.compiler !== 'gcc' && { shiftPastWidth: this.compiler === 'msvc' ? ('zero' as const) : ('host32' as const) }),
    };
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
    this.typedefNames.clear();
    this.typedefSpellings.clear();
    this.aliasAlignments.clear();
    this.enumConstants.clear();
    this.definitionOrder = [];
    this.anonymousTypeCounter = 0;
    this.defining = [];
    this.usedIncomplete.clear();

    this.pre = preprocess(code, { integers: this.integers, bareCrEndsLine: this.compiler !== 'msvc' });
    this.errors.push(...this.pre.errors);
    this.warnings.push(...this.pre.warnings);
    this.tokens = this.pre.tokens;
    this.pos = 0;
    this.nesting = new Nesting();

    while (this.pos < this.tokens.length) {
      const start = this.pos;
      try {
        this.parseTopLevel();
      } catch (err) {
        if (err instanceof NestingError) {
          // Past the limit, what follows is not read: it is inside what could not be.
          this.errors.push({ message: err.message, line: err.line ?? this.currentLine(), type: 'syntax' });
          this.pos = this.tokens.length;
          break;
        }
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

  /** The tokens from..to (exclusive) as written, macros expanded. */
  private spell(from: number, to: number): string[] {
    return this.tokens.slice(from, to).map((t) => t.value);
  }

  private get language(): SourceLanguage {
    return this.target.language ?? 'c';
  }

  private get isCpp(): boolean {
    return this.language !== 'c';
  }

  /** A C++ construct in C source is an error, as it is for a C compiler. */
  private requireCpp(what: string, line = this.currentLine()): void {
    if (!this.isCpp) this.fail(`${what} is C++, not C: choose C++ as the language to lay this out.`, line);
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
    return { identifier: (name) => this.enumConstants.get(name), types: this.oracle, integers: this.integers, nesting: this.nesting };
  }

  private evaluate(tokens: Token[], what: string, line: number): number {
    try {
      return evaluateConstExpr(tokens, this.exprContext());
    } catch (err) {
      // A type in the expression that is already reported (Recover), or nesting past the limit.
      if (!(err instanceof ConstExprError)) throw err;
      return this.fail(`${what} '${tokens.map((t) => t.value).join(' ')}' is not an integer constant: ${err.message}.`, line);
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
      this.requireCpp(`extern ${this.peek(1)!.value}`, t.line);
      this.pos += 2;
      if (this.isPunct('{')) this.pos += 1;
      return;
    }
    if (t.kind === 'id' && t.value === 'namespace') {
      this.requireCpp('A namespace', t.line);
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
      this.requireCpp(`'${t.value}'`, t.line);
      if (t.value === 'using' && this.parseAliasDeclaration()) {
        this.expectPunct(';', 'after the alias declaration');
        return;
      }
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
      // A K&R definition (C before C23): its parameters' declarations, then its body.
      if (decl.derivations[0]?.kind === 'func' && !this.isCpp && declarators.length === 1 && (this.isId('register') || this.startsTypeName(this.peek()))) {
        if (this.compiler === 'sdcc') {
          this.fail(`SDCC rejects the old-style definition of '${decl.name ?? ''}': declare its parameters' types in the parameter list.`, decl.line);
        }
        while (this.pos < this.tokens.length && !this.isPunct('{')) {
          if (this.isPunct('(') || this.isPunct('[')) this.pos = findClosing(this.tokens, this.pos);
          this.pos += 1;
        }
        if (!this.isPunct('{')) this.fail(`Expected the body of '${decl.name ?? ''}' after its parameter declarations.`, decl.line);
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
    this.typedefNames.add(name);
    this.typedefSpellings.set(name, this.spellType(spec, decl.derivations, false));
    // `typedef int a8 __attribute__((aligned(8)));` gives the new type its own alignment.
    const aligned = this.requestedAlignment(spec.attrs, decl.attrs);
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
    if (this.compiler === 'msvc' && info.dims.includes(0)) {
      this.errors.push({ message: `MSVC rejects the zero-length array type '${name}' (C2466).`, line: decl.line, type: 'semantic' });
      return;
    }
    this.typeAliases.set(name, { ...info, declaredType: name, ...(aligned !== undefined && { typeAlignment: aligned }) });
  }

  /**
   * C++ `using Name = type-id` at `using`, up to its ';': an alias, registered as a typedef is.
   * False, consuming nothing, for any other `using` (a using-directive or using-declaration).
   */
  private parseAliasDeclaration(): boolean {
    const nameTok = this.peek(1);
    if (nameTok?.kind !== 'id' || KEYWORDS.has(nameTok.value)) return false;
    let k = 2;
    if (this.isPunct('[', k) && this.isPunct('[', k + 1)) k = findClosing(this.tokens, this.pos + k) - this.pos + 1;
    if (!this.isPunct('=', k)) return false;
    this.pos += k + 1;
    const spec = this.parseSpecifiers(null, false);
    if (!spec.base) this.fail(`Expected a type after 'using ${nameTok.value} ='.`, nameTok.line);
    const decl = this.parseDeclarator(true);
    if (decl.name !== undefined) this.fail(`Expected a type after 'using ${nameTok.value} =' but found the name '${decl.name}'.`, nameTok.line);
    this.registerTypedef(spec, { ...decl, name: nameTok.value });
    return true;
  }

  // ------------------------------------------------------------------ specifiers

  private parseSpecifiers(ownerName: string | null, topLevel: boolean): Specifiers {
    const spec: Specifiers = {
      isTypedef: false,
      isStatic: false,
      isVirtual: false,
      isFriend: false,
      isExplicit: false,
      cv: [],
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
      if (CPP_ONLY_SPECIFIERS.has(v)) this.requireCpp(`'${v}'`, t.line);
      if (QUALIFIERS.has(v)) {
        if (v === 'const' || v === 'volatile') {
          written.push(v);
          spec.cv.push(v);
        }
        if (v === 'explicit') spec.isExplicit = true;
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
      if (v === 'decltype' && !spec.base && this.isPunct('(', 1)) {
        // C++: decltype(nullptr) is std::nullptr_t; the type of any other expression is not worked out.
        this.requireCpp("'decltype'", t.line);
        const close = findClosing(this.tokens, this.pos + 1);
        if (close === -1) this.fail("Unterminated 'decltype(...)'.", t.line);
        const inner = this.tokens.slice(this.pos + 2, close);
        if (inner.length !== 1 || inner[0].value !== 'nullptr') {
          this.fail(`decltype(${inner.map((x) => x.value).join(' ')}) is not supported: only decltype(nullptr), std::nullptr_t, is.`, t.line);
        }
        this.pos = close + 1;
        spec.base = { kind: 'name', name: 'nullptr_t' };
        written.push('decltype(nullptr)');
        continue;
      }
      if ((v === 'typeof' || v === '__typeof__' || v === '__typeof') && !spec.base && this.isPunct('(', 1)) {
        // GCC (gnu11) has all three; MSVC only __typeof__; SDCC none (each measured).
        const accepted = this.compiler === 'gcc' || (this.compiler === 'msvc' && v === '__typeof__');
        if (!accepted) this.fail(`${this.compiler === 'msvc' ? 'MSVC' : 'SDCC'} does not accept '${v}'.`, t.line);
        const close = findClosing(this.tokens, this.pos + 1);
        if (close === -1) this.fail(`Unterminated '${v}(...)'.`, t.line);
        const inner = this.tokens.slice(this.pos + 2, close);
        const spelled = `${v}(${inner.map((x) => x.value).join(' ')})`;
        const type = this.typeOf(inner, spelled, t.line);
        this.pos = close + 1;
        spec.base = { kind: 'typeof', type, spelled };
        written.push(spelled);
        continue;
      }
      if (!spec.base && !KEYWORDS.has(v)) {
        // A typedef name, possibly qualified (std::uint8_t): the last component names the type.
        let name = v;
        this.pos += 1;
        while (this.isPunct('::') && this.peek(1)?.kind === 'id') {
          this.requireCpp(`The qualified name '${name}::${this.peek(1)!.value}'`);
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

  /** What `typeof(inner)` names: a type-name, or the type of an expression this evaluator can type. */
  private typeOf(inner: Token[], spelled: string, line: number): TypeInfo {
    return this.nesting.in(() => this.typeOfAt(inner, spelled, line), line);
  }

  private typeOfAt(inner: Token[], spelled: string, line: number): TypeInfo {
    const named = this.oracle.typeName(inner, 0);
    if (named && named.end === inner.length) return named.type;
    try {
      const t = expressionType(inner, this.exprContext());
      if ('object' in t) return t.object;
      if ('string' in t) return { type: 'char', isPointer: false, dims: [t.string] };
      const scalar = this.oracle.typeName(tokenize(t.scalar), 0);
      if (!scalar) throw new ConstExprError(`its type '${t.scalar}' has no name here`);
      return scalar.type;
    } catch (err) {
      if (!(err instanceof ConstExprError)) throw err;
      return this.fail(`${spelled}: ${err.message}.`, line);
    }
  }

  private parseRecordSpecifier(ownerName: string | null, topLevel: boolean): Extract<BaseSpec, { kind: 'record' }> {
    const kwToken = this.peek()!;
    const kwIndex = this.pos;
    const keyword: RecordKeyword = kwToken.value === 'union' ? 'union' : 'struct';
    this.pos += 1;
    const attrs: Attributes = {};
    this.parseAttributes(attrs);

    let tag: string | undefined;
    if (this.peek()?.kind === 'id' && !KEYWORDS.has(this.peek()!.value)) {
      tag = this.peek()!.value;
      this.pos += 1;
      while (this.isPunct('::') && this.peek(1)?.kind === 'id') {
        this.requireCpp(`The qualified name '${tag}::${this.peek(1)!.value}'`);
        tag = this.peek(1)!.value;
        this.pos += 2;
      }
    }
    this.parseAttributes(attrs);
    if (this.isId('final') && (this.isPunct(':', 1) || this.isPunct('{', 1))) {
      this.requireCpp("'final'");
      this.pos += 1;
    }

    const bases = this.isPunct(':') ? this.parseBaseClause(keyword, tag, kwToken.value === 'class') : [];
    if (!this.isPunct('{')) {
      if (bases.length > 0) this.fail(`Expected the body of '${keyword} ${tag ?? ''}' after its base classes.`);
      return { kind: 'record', keyword, tag };
    }

    const open = this.pos;
    const close = findClosing(this.tokens, open);
    if (close === -1) {
      this.fail(`Unterminated ${keyword} definition${tag ? ` '${tag}'` : ''}: missing '}'.`, kwToken.line);
    }

    const name = tag ?? (topLevel ? '' : this.createAnonymousTypeName(keyword, ownerName ?? 'anon'));
    const def: ParsedStruct = { name, members: [], line: kwToken.line };
    if (keyword === 'union') def.isUnion = true;
    if (this.isCpp) {
      def.cpp = {
        key: kwToken.value === 'class' ? 'class' : keyword,
        standard: this.language === 'c++20' ? 'c++20' : 'c++17',
        bases,
        methods: [],
        ...(attrs.emptyBases && { emptyBases: true }),
        userProvidedConstructor: false,
        userDeclaredConstructor: false,
        explicitConstructor: false,
        userProvidedDestructor: false,
        userDeclaredDestructor: false,
        userProvidedCopyAssignment: false,
        nonPublicData: false,
        defaultMemberInitializer: false,
        referenceMember: false,
        // MSVC fixes the model of a class a pointer to member named before its definition.
        ...(tag !== undefined && this.usedIncomplete.has(tag) && { inheritanceModel: 'unspecified' as const }),
      };
    }

    // MSVC takes 16 levels of nested record definitions, the outermost included: one more is fatal
    // error C1046, "struct nested too deeply" (measured with cl 19.44, C and C++, tagged, anonymous
    // and union; Microsoft documents the limit as 16 against the C++ standard's 256).
    if (this.compiler === 'msvc' && this.defining.length >= 16) {
      this.fail(`MSVC does not take this ${keyword}: it is nested inside 16 others (fatal error C1046, ${keyword} nested too deeply).`, kwToken.line);
    }
    this.pos = open + 1;
    this.defining.push(def);
    try {
      def.members = this.nesting.in(() => this.parseBody(close, def.name || `${keyword} (anonymous)`, def), kwToken.line);
    } finally {
      this.defining.pop();
    }
    this.pos = close + 1;

    this.parseAttributes(attrs);
    if (attrs.packed) def.packed = true;
    const aligned = this.requestedAlignment(attrs);
    if (aligned !== undefined) def.alignAttribute = aligned;
    def.source = { head: this.spell(kwIndex, open), tail: this.spell(close + 1, this.pos) };
    this.applyPragmaPack(def, this.tokens[this.pos - 1]!.line);

    // Tagged definitions are visible by tag immediately; anonymous top-level ones are named by
    // their typedef in finishTopLevelRecord.
    if (tag) this.registerRecord(def, false);
    else if (!topLevel) this.registerRecord(def, false);
    return { kind: 'record', keyword, tag, def };
  }

  /**
   * The #pragma pack a record is laid out under, measured mid-record with gcc and MSVC: GCC lays
   * the record out where it ends (`end`: its '}' or the attributes after it), under the pack in
   * effect there, members declared before a change included. MSVC caps each member by the pack in
   * effect at its declaration and rounds the size by the one in effect at the end; recorded on
   * a member (StructMember.pragmaPack) where the two differ.
   */
  private applyPragmaPack(def: ParsedStruct, end: number): void {
    if (!this.pre) return;
    const pack = packAt(this.pre.packEvents, end);
    if (pack !== undefined) def.pragmaPack = pack;
    for (const m of def.members) {
      const own = m.line !== undefined ? packAt(this.pre.packEvents, m.line) : pack;
      if (own !== pack) m.pragmaPack = own ?? null;
    }
  }

  /** `: public A, virtual B, ...`: each base must be a class defined before this point. */
  private parseBaseClause(keyword: RecordKeyword, tag: string | undefined, isClass: boolean): CppBase[] {
    const what = `${keyword} ${tag ?? '(anonymous)'}`;
    this.requireCpp('A base class list');
    if (keyword === 'union') this.fail(`'${what}' is a union, which cannot have base classes.`);
    this.pos += 1;
    const bases: CppBase[] = [];
    for (;;) {
      const line = this.currentLine();
      let isVirtual = false;
      let access: CppBase['access'] = isClass ? 'private' : 'public';
      for (;;) {
        const v = this.peek()?.value;
        if (v === 'virtual') isVirtual = true;
        else if (v === 'public' || v === 'protected' || v === 'private') access = v;
        else break;
        this.pos += 1;
      }
      this.parseAttributes({});
      if (this.isPunct('::')) this.pos += 1;
      let name = this.peek()?.kind === 'id' ? this.peek()!.value : this.fail(`Expected a base class name in '${what}'.`);
      this.pos += 1;
      while (this.isPunct('::') && this.peek(1)?.kind === 'id') {
        name = this.peek(1)!.value;
        this.pos += 2;
      }
      if (this.isPunct('<')) this.fail(`Base class '${name}<...>' of '${what}' is a template, which is not supported.`, line);
      // A class named by its own name or by an alias of it (`using B = A;`, `typedef A B;`).
      const alias = this.typeAliases.get(name);
      const aliased = alias?.recordRef && !alias.isPointer && !alias.memberPointer && alias.dims.length === 0 ? alias.nestedStruct ?? this.resolveStructTypeByName(alias.recordRef.name) : undefined;
      const def = this.resolveStructTypeByName(name) ?? aliased;
      if (!def) this.fail(`Base class '${name}' of '${what}' has no definition before it.`, line);
      if (def!.isUnion) this.fail(`Base class '${name}' of '${what}' is a union, which cannot be a base class.`, line);
      if (bases.some((b) => b.def === def)) this.fail(`'${name}' is a direct base of '${what}' more than once.`, line);
      bases.push({ def: def!, virtual: isVirtual, access, line });
      if (!this.isPunct(',')) break;
      this.pos += 1;
    }
    return bases;
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
    if (this.isId('class') || this.isId('struct')) {
      this.requireCpp(`'enum ${this.peek()!.value}'`);
      this.pos += 1;
    }
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
    this.retypeEnumerators(def);

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
    const int = integerType(this.integers, 'int');
    let next: { value: bigint; type: IntType } = { value: 0n, type: int };
    /** An enumeration constant is an int where its value fits one; otherwise it keeps its value's type. */
    const constant = (c: { value: bigint; type: IntType }) => {
      const fits = c.value >= -(1n << BigInt(int.bits - 1)) && c.value < 1n << BigInt(int.bits - 1);
      return { value: c.value, type: fits ? int : c.type };
    };
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
          // A signed overflow here only warns: GCC takes the wrapped value.
          next = constant(evaluateIntegerConstExpr(exprTokens, { ...this.exprContext(), allowOverflow: true }));
          member.value = Number(next.value);
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
        member.value = Number(next.value);
      }
      if (member.value !== undefined) {
        this.enumConstants.set(member.name, next);
        next = constant({ value: next.value + 1n, type: next.type });
      }
      members.push(member);
      if (this.isPunct(',')) this.pos += 1;
    }
    return members;
  }

  /**
   * After its definition, an enumeration constant whose value does not fit an int has the enum's
   * type under GCC (unsigned when no value is negative), and is an int under MSVC (measured: the
   * enum stays int-sized there).
   */
  private retypeEnumerators(def: ParsedEnum): void {
    const int = integerType(this.integers, 'int');
    const values = def.members.flatMap((m) => (m.value === undefined ? [] : [BigInt(m.value)]));
    const unsigned = values.every((v) => v >= 0n);
    const bits = 8 * this.calculator.measure({ name: '', type: `enum ${def.name}`, enumType: def }).size;
    const enumType: IntType = { name: def.underlyingType ?? `enum ${def.name}`, bits, unsigned, rank: bits > int.bits ? (bits > this.integers.long ? 5 : 4) : 3 };
    for (const m of def.members) {
      const c = this.enumConstants.get(m.name);
      if (typeof c !== 'object' || c.type.name === int.name) continue;
      if (this.compiler === 'msvc') this.enumConstants.set(m.name, { value: BigInt.asIntN(int.bits, c.value), type: int });
      else if (this.compiler === 'gcc') this.enumConstants.set(m.name, { value: c.value, type: enumType });
    }
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
    if (this.target.architecture.bitfieldLayout === 'ms' && (t.value === '__attribute__' || t.value === '__attribute' || t.value === '__packed')) {
      this.fail(`MSVC does not accept '${t.value}': on Windows use #pragma pack, alignas or __declspec(align(n)).`, t.line);
    }
    // SDCC has no attributes either, and GCC no __declspec (syntax errors, measured).
    if (this.compiler === 'sdcc' && (t.value === '__attribute__' || t.value === '__attribute' || t.value === '__packed' || t.value === '__declspec')) {
      this.fail(`SDCC does not accept '${t.value}': use #pragma pack.`, t.line);
    }
    if (this.compiler === 'gcc' && t.value === '__declspec') {
      this.fail("GCC does not accept '__declspec' outside Windows: use __attribute__((aligned(n))) or _Alignas.", t.line);
    }
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
      attrs.aligned = this.strictest(attrs.aligned, this.alignRequestFrom(inner, t));
      return;
    }
    if (t.value === '__declspec') {
      // __declspec(align(n)) and (empty_bases); others (dllexport, novtable...) have no layout effect.
      for (let i = 0; i < inner.length; i++) {
        if (inner[i].value === 'align' && inner[i + 1]?.value === '(') {
          const end = findClosing(inner, i + 1);
          // MSVC keeps the last of several (warning C4141).
          attrs.declspecAlign = this.evaluate(inner.slice(i + 2, end), 'Alignment', t.line);
        }
        if (inner[i].value === 'empty_bases') attrs.emptyBases = true;
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
        attrs.aligned = this.strictest(attrs.aligned, args.length === 0 ? 'max' : this.evaluate(args, 'Alignment', nameTok.line));
      } else if (UNMODELLED_LAYOUT_ATTRIBUTES.has(name)) {
        this.warnings.push({ message: `__attribute__((${name})) changes layout and is not modelled.`, line: nameTok.line, type: 'warning' });
      }
      i = list[j]?.value === ',' ? j + 1 : j;
    }
  }

  /**
   * C++11 / C23 [[...]] attributes. Only [[no_unique_address]], which the Itanium ABI honours,
   * and [[msvc::no_unique_address]], which MSVC honours instead, affect layout.
   */
  private parseStdAttributes(attrs: Attributes): void {
    const close = findClosing(this.tokens, this.pos);
    const inner = this.tokens.slice(this.pos + 2, close - 1);
    this.pos = close + 1;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i].value !== 'no_unique_address') continue;
      const msvc = inner[i - 1]?.value === '::' && inner[i - 2]?.value === 'msvc';
      this.requireCpp(`[[${msvc ? 'msvc::' : ''}no_unique_address]]`, inner[i].line);
      attrs.noUniqueAddress = msvc ? 'msvc' : 'std';
    }
  }

  /**
   * The stricter of two alignment requests: several on one declaration (`aligned`, alignas, and
   * MSVC's last `__declspec(align)`) all count, so the largest wins (GCC and MSVC). alignas(0) asks
   * for nothing (C11 6.7.5p6).
   */
  private strictest(a: AlignRequest | undefined, b: AlignRequest | undefined): AlignRequest | undefined {
    const value = (r: AlignRequest) => this.calculator.resolveAlignRequest(r);
    if (a === undefined || (b !== undefined && value(a) === 0)) return b;
    if (b === undefined || value(b) === 0) return a;
    return value(b) > value(a) ? b : a;
  }

  /** The alignment requested by a declaration's attributes and specifiers together. */
  private requestedAlignment(...sets: Attributes[]): AlignRequest | undefined {
    return sets.reduce<AlignRequest | undefined>((r, s) => this.strictest(this.strictest(r, s.aligned), s.declspecAlign), undefined);
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
   * C++ `A::*` or `N::A::*` at `offset` from the current token: the start of a pointer to member.
   * The class it names (the last name) and the tokens it takes, the '*' included.
   */
  private memberPointerScope(offset: number): { name: string; length: number } | undefined {
    let k = offset;
    if (this.isPunct('::', k)) k += 1;
    let name: string | undefined;
    while (this.peek(k)?.kind === 'id' && !KEYWORDS.has(this.peek(k)!.value) && this.isPunct('::', k + 1)) {
      name = this.peek(k)!.value;
      k += 2;
    }
    return name !== undefined && this.isPunct('*', k) ? { name, length: k + 1 - offset } : undefined;
  }

  /**
   * Parse one declarator. Derivations are collected from the name outward, following C's
   * precedence: suffixes ([] and ()) bind tighter than a prefix '*'.
   */
  private parseDeclarator(allowAbstract: boolean): Declarator {
    const line = this.currentLine();
    const attrs: Attributes = {};
    /** Pointers and references as written, left to right; each takes the qualifiers after it. */
    const prefix: Array<Extract<Derivation, { kind: 'ptr' }>> = [];
    for (;;) {
      if (this.isPunct('*') || this.isPunct('&') || this.isPunct('&&') || this.isPunct('^')) {
        const v = this.peek()!.value;
        if (v === '&' || v === '&&') this.requireCpp(`A reference ('${v}')`);
        prefix.push(v === '&' || v === '&&' ? { kind: 'ptr', ref: v } : { kind: 'ptr' });
        this.pos += 1;
        continue;
      }
      const scope = this.memberPointerScope(0);
      if (scope) {
        this.requireCpp(`A pointer to member ('${scope.name}::*')`);
        prefix.push({ kind: 'ptr', memberOf: scope.name });
        this.pos += scope.length;
        continue;
      }
      const t = this.peek();
      if (t?.kind === 'id' && QUALIFIERS.has(t.value)) {
        const last = prefix[prefix.length - 1];
        if (last && (t.value === 'const' || t.value === 'volatile')) last.cv = [...(last.cv ?? []), t.value];
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
    if (this.isPunct('(') && (this.isPunct('*', 1) || this.isPunct('&', 1) || this.isPunct('^', 1) || this.isPunct('(', 1) || this.memberPointerScope(1))) {
      this.pos += 1;
      inner = this.nesting.in(() => this.parseDeclarator(allowAbstract), line);
      this.expectPunct(')', 'to close the parenthesized declarator');
    } else if (this.peek()?.kind === 'id' && !KEYWORDS.has(this.peek()!.value)) {
      inner.name = this.peek()!.value;
      this.pos += 1;
      // C++ out-of-line names (A::b) and operator names are not members; keep the last part.
      while (this.isPunct('::') && this.peek(1)?.kind === 'id') {
        this.requireCpp(`The qualified name '${inner.name}::${this.peek(1)!.value}'`);
        inner.name = this.peek(1)!.value;
        this.pos += 2;
      }
    } else if (this.isId('operator')) {
      this.requireCpp("'operator'");
      this.pos += 1;
      // `operator()` names itself with parentheses; any other operator runs up to its '('.
      if (this.isPunct('(') && this.isPunct(')', 1)) {
        inner.name = 'operator()';
        this.pos += 2;
      } else {
        inner.name = `operator${this.takeUntil(['(']).map((t) => t.value).join(' ')}`;
      }
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
        const paramTokens = this.tokens.slice(this.pos + 1, close);
        const params = paramTokens.map((t) => t.value).join(' ').replace(/ ([,)])/g, '$1');
        this.pos = close + 1;
        // Trailing method qualifiers, ref-qualifiers and specifiers.
        const quals: string[] = [];
        for (;;) {
          const q = this.peek();
          if (q?.kind === 'id' && ['const', 'volatile', 'override', 'final', 'noexcept', 'throw'].includes(q.value)) {
            quals.push(q.value);
            this.pos += 1;
            if (this.isPunct('(')) this.pos = findClosing(this.tokens, this.pos) + 1;
          } else if (q?.kind === 'punct' && (q.value === '&' || q.value === '&&') && inner.name !== undefined) {
            quals.push(q.value);
            this.pos += 1;
          } else {
            break;
          }
        }
        suffixes.push({ kind: 'func', params, paramTokens, quals });
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
      // The pointer written last is the one nearest the name.
      derivations: [...inner.derivations, ...suffixes, ...prefix.reverse()],
      attrs: { ...inner.attrs, ...attrs, aligned: this.strictest(inner.attrs.aligned, attrs.aligned) },
      line,
    };
    if (result.attrs.aligned === undefined) delete result.attrs.aligned;
    // Pointer, array and function declarators in one declaration: 256 is C++'s [implimits] minimum.
    if (result.derivations.length > MAX_NESTING) throw new NestingError(line);

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
        // Complex types: GCC's; MSVC and SDCC reject `_Complex` (measured).
        if (base.words.includes('_Complex') && this.compiler !== 'gcc') {
          this.fail(`${this.compiler === 'msvc' ? 'MSVC' : 'SDCC'} does not accept '_Complex'.`, spec.line);
        }
        // __int128: GCC's 64-bit targets only (measured on each, and with MSVC and SDCC).
        if (base.words.includes('__int128') && !this.hasInt128) {
          this.fail(
            this.compiler === 'gcc' ? "GCC does not support '__int128' on this target: only on 64-bit ones." : `${this.compiler === 'msvc' ? 'MSVC' : 'SDCC'} does not accept '__int128'.`,
            spec.line,
          );
        }
        return { type: canonicalBuiltin(base.words), isPointer: false, dims: [] };
      case 'typeof':
        return { ...base.type, dims: [...base.type.dims] };
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
        // In C a tag is not a type name: `struct S` or a typedef is needed. C++ makes it one.
        if (!this.isCpp && !this.typedefNames.has(base.name)) {
          const tag = this.structs.has(base.name) ? 'struct' : this.unions.has(base.name) ? 'union' : this.enums.has(base.name) ? 'enum' : undefined;
          if (tag) this.fail(`'${base.name}' is not a type name in C: write '${tag} ${base.name}', or choose C++.`, spec.line);
        }
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

  /**
   * GCC rejects an array whose element type is aligned beyond its size ("alignment of array
   * elements is greater than element size"), as an aligned typedef can make it; MSVC accepts it and
   * keeps the elements at the type's size apart (both measured).
   */
  private checkArrayElement(element: TypeInfo, name: string, line: number): void {
    if (this.compiler !== 'gcc' || element.typeAlignment === undefined) return;
    let size: number;
    try {
      size = this.calculator.measure(this.measurable(element)).size;
    } catch (err) {
      if (err instanceof ConstExprError) return; // an incomplete element is reported where it is used
      throw err;
    }
    const alignment = this.calculator.resolveAlignRequest(element.typeAlignment);
    if (alignment > size) {
      this.fail(`The elements of '${name}' are aligned to ${alignment} bytes, more than their size (${size}): GCC rejects such an array.`, line);
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
    // `[]` first is a flexible array member; `[0]` is GNU's zero-length array, an array of no
    // elements, except under SDCC, which takes it for a flexible array member (measured).
    const first = d[0]?.kind === 'array' ? (d[0] as { size: number | null }).size : undefined;
    const flexible = first === null || (first === 0 && this.compiler === 'sdcc');
    // MSVC: only the first dimension may be 0 (C2087).
    if (this.compiler === 'msvc' && [...dims.slice(1), ...base.dims].includes(0)) {
      this.fail(`MSVC rejects a zero-length inner dimension in '${name}' (C2087).`, decl.line);
    }
    if (dims.length > 0) this.checkArrayElement(base, name, decl.line);

    if (rest.length === 0) {
      // An array of the type, which may itself be an array (or an array of pointers) by typedef.
      return { ...base, dims: [...dims, ...base.dims], ...(flexible && { flexible: true }) };
    }
    if (rest[0].kind === 'func') {
      this.fail(`'${name}' is declared as a function returning ${base.type}; only pointers to functions can be members.`, decl.line);
    }
    const memberOf = (x: Derivation | undefined) => (x?.kind === 'ptr' ? x.memberOf : undefined);
    const cls = memberOf(rest[0]);
    if (cls !== undefined) {
      // A pointer to member: to a member function, or to data of the type the rest declares.
      const fn = rest[1]?.kind === 'func' ? rest[1] : undefined;
      const of = (from: number) => this.describeType(this.applyDeclarator(base, { ...decl, derivations: rest.slice(from) }, name));
      const quals = fn ? fn.quals.filter((q) => q === 'const' || q === 'volatile' || q === '&' || q === '&&').map((q) => ` ${q}`).join('') : '';
      const type = fn ? `${of(2)} (${cls}::*)(${fn.params})${quals}` : `${of(1)} ${cls}::*`;
      return { type, isPointer: false, memberPointer: { className: cls, function: fn !== undefined }, dims };
    }
    // Pointer (to anything, including arrays and functions): the member stores an address.
    // One '*' per pointer level before any function/array derivation: char** stays char**.
    let levels = 0;
    while (rest[levels]?.kind === 'ptr' && memberOf(rest[levels]) === undefined) levels += 1;
    const func = memberOf(rest[levels]) === undefined ? rest.find((x): x is Extract<Derivation, { kind: 'func' }> => x.kind === 'func') : undefined;
    // One pointer straight onto a function; a pointer to a function pointer points at data.
    const functionPointer = levels === 1 && rest[1]?.kind === 'func';
    // A pointer to a pointer to member points at that type.
    const pointedType = memberOf(rest[levels]) !== undefined ? this.applyDeclarator(base, { ...decl, derivations: rest.slice(levels) }, name).type : base.type;
    return {
      type: `${pointedType}${'*'.repeat(Math.max(1, levels))}`,
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
    const cpp = owner.cpp;
    /** C++ access in effect: a class starts private, a struct or union public. */
    let access = cpp?.key === 'class' ? 'private' : 'public';

    while (this.pos < close) {
      const start = this.pos;
      const membersBefore = members.length;
      try {
        const t = this.peek()!;
        if (t.kind === 'punct' && t.value === ';') {
          this.pos += 1;
          continue;
        }
        // C++ access labels.
        if (t.kind === 'id' && ['public', 'private', 'protected'].includes(t.value) && this.isPunct(':', 1)) {
          this.requireCpp(`The access label '${t.value}:'`, t.line);
          access = t.value;
          this.pos += 2;
          continue;
        }
        if (t.kind === 'id' && (t.value === 'static_assert' || t.value === '_Static_assert')) {
          this.checkStaticAssert();
          continue;
        }
        if (t.kind === 'id' && (t.value === 'using' || t.value === 'friend')) {
          this.requireCpp(`'${t.value}'`, t.line);
          // A member alias declares a type name and takes no space; a using-declaration names a base's members.
          if (t.value === 'using' && this.parseAliasDeclaration()) this.endMember(close, ownerName, undefined);
          else this.skipMember(close);
          continue;
        }
        let templated = false;
        if (t.kind === 'id' && t.value === 'template') {
          // A member template: only a constructor template affects layout (it is user-provided).
          this.requireCpp("'template'", t.line);
          this.skipTemplateHeader();
          templated = true;
        }

        if (cpp && this.parseConstructorOrDestructor(owner, close)) continue;
        if (templated) {
          this.skipMember(close);
          continue;
        }

        const spec = this.parseSpecifiers(ownerName, false);
        if (!spec.base) {
          if (this.isPunct('~') || (this.peek()?.kind === 'id' && this.isPunct('(', 1))) {
            this.requireCpp('A constructor or destructor');
          }
          if (this.isId('operator')) {
            // A conversion function, `operator int() const`: a member function with no return type.
            spec.base = { kind: 'builtin', words: ['void'] };
          } else {
            this.fail(`Unexpected '${this.peek()?.value ?? t.value}' in member declaration of '${ownerName}'.`, t.line);
          }
        }

        if (spec.isTypedef) {
          // Member typedef (C++): declares a type name, takes no space.
          this.requireCpp('A typedef inside a struct', spec.line);
          for (;;) {
            const decl = this.parseDeclarator(false);
            if (decl.name) this.registerTypedef(spec, decl);
            if (this.isPunct(',')) { this.pos += 1; continue; }
            break;
          }
          this.endMember(close, ownerName, undefined);
          continue;
        }

        const specEnd = this.pos;
        if (this.isPunct(';') || this.pos >= close) {
          // No declarator: a C11 anonymous struct/union member, or just a nested type declaration.
          if (spec.base!.kind === 'record' && spec.base!.def && !spec.base!.tag) {
            members.push({
              name: '',
              type: `${spec.base!.keyword} ${spec.base!.def.name}`,
              isNested: true,
              nestedStruct: spec.base!.def,
              line: spec.line,
              source: { spec: this.spell(start, specEnd), declarator: [], inlineType: true },
            });
          } else if (spec.base!.kind !== 'record' && spec.base!.kind !== 'enum') {
            this.warnings.push({ message: `Declaration in '${ownerName}' does not declare a member.`, line: spec.line, type: 'warning' });
          }
          this.endMember(close, ownerName, undefined);
          continue;
        }

        let lastName: string | undefined;
        // A record type defined in the specifiers: the first declarator carries the definition, the
        // others refer to it by tag (an anonymous one is defined again, with the same layout).
        const inlineRecord = spec.base!.kind === 'record' && spec.base!.def ? spec.base! : undefined;
        let first = true;
        let member: StructMember | null = null;
        for (;;) {
          const declStart = this.pos;
          const decl = this.parseDeclarator(true);
          lastName = decl.name ?? lastName;
          const func = decl.derivations[0]?.kind === 'func' ? decl.derivations[0] : undefined;

          if (func) {
            this.requireCpp(decl.name ? `The member function '${decl.name}'` : 'A constructor', decl.line);
            const tail = this.parseFunctionTail();
            if (cpp && decl.name && !spec.isStatic && !spec.isFriend) {
              const declaredVirtual = spec.isVirtual || func.quals.includes('override') || func.quals.includes('final');
              cpp.methods.push({ name: decl.name, signature: this.methodSignature(func), declaredVirtual, pure: tail.pure, destructor: false });
              if (decl.name === 'operator=' && !tail.defaulted && !tail.deleted && this.isCopyAssignmentParameter(func.paramTokens, owner.name)) {
                cpp.userProvidedCopyAssignment = true;
              }
            }
            if (tail.body) {
              lastName = undefined;
              break;
            }
          } else if (spec.isStatic || spec.isFriend) {
            if (spec.isStatic) this.requireCpp('A static member', decl.line);
          } else {
            member = this.buildMember(spec, decl, ownerName);
            if (member) {
              if (cpp) {
                if (access === 'private' || access === 'protected') {
                  cpp.nonPublicData = true;
                  member.access = access;
                }
                if (member.reference) cpp.referenceMember = true;
              }
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
            // Default member initializer: `= expr` or `{ ... }`.
            if (this.isPunct('=') || this.isPunct('{')) {
              this.requireCpp(`The default member initializer of '${decl.name ?? ''}'`, decl.line);
              if (cpp) cpp.defaultMemberInitializer = true;
            }
          }

          // A static member's initializer, or a default member initializer: no layout effect.
          if (this.isPunct('=')) { this.pos += 1; this.takeUntil([',', ';']); }
          else if (this.isPunct('{')) { this.pos = findClosing(this.tokens, this.pos) + 1; }

          if (member) {
            const tagged = inlineRecord?.tag;
            member.source = {
              spec: !first && tagged ? [inlineRecord!.keyword, tagged] : this.spell(start, specEnd),
              declarator: this.spell(declStart, this.pos),
              ...(inlineRecord && (first || !tagged) && { inlineType: true }),
            };
          }
          member = null;
          first = false;
          if (this.isPunct(',')) { this.pos += 1; continue; }
          break;
        }
        if (lastName === undefined && !this.isPunct(';')) continue; // method with a body: no ';'
        this.endMember(close, ownerName, lastName);
      } catch (err) {
        if (!(err instanceof Recover)) throw err;
        this.skipMember(close);
      } finally {
        // What declared no data member, as written: a member function, a nested type, a typedef...
        const tokens = this.spell(start, Math.min(this.pos, close));
        const label = tokens.length === 2 && ['public', 'private', 'protected'].includes(tokens[0]!) && tokens[1] === ':';
        if (members.length === membersBefore && tokens.length > 0 && !(tokens.length === 1 && tokens[0] === ';') && !label) {
          (owner.declarations ??= []).push({ tokens, ...(cpp && { access: access as 'public' | 'protected' | 'private' }) });
        }
      }
      if (this.pos === start) this.pos += 1;
    }

    this.checkFlexibleMembers(members, owner, ownerName);
    return members;
  }

  /**
   * Where a flexible array member may be, as each compiler has it (measured). GCC: last in a struct
   * with another named member, never in a union; a GNU zero-length array goes anywhere. SDCC (whose
   * `[0]` is a flexible member too): last in a struct with another member, or in a union; a struct
   * ending in one is no member. MSVC: a flexible or zero-length array last in a struct, or in a
   * union; a struct ending in one is no member (C2229).
   */
  private checkFlexibleMembers(members: StructMember[], owner: ParsedStruct, ownerName: string): void {
    const c = this.compiler;
    const unsized = (m: StructMember) => m.flexible === true || (c === 'msvc' && m.arrayDims?.[0] === 0);
    const error = (m: StructMember, message: string) => this.errors.push({ message, line: m.line, type: 'semantic' });
    members.forEach((m, i) => {
      if (unsized(m)) {
        if (owner.isUnion) {
          if (c === 'gcc') error(m, `Flexible array member '${m.name}' is not allowed in union '${ownerName}'.`);
          // SDCC: a union of nothing but flexible array members is incomplete.
          else if (c === 'sdcc' && members.every(unsized) && i === 0) error(m, `Union '${ownerName}' has only flexible array members, which SDCC takes for an incomplete type.`);
        } else if (i !== members.length - 1) {
          error(m, `${m.flexible ? 'Flexible' : 'Zero-length'} array member '${m.name}' must be the last member of '${ownerName}'.`);
        } else if (c !== 'msvc' && !members.some((o) => o !== m && (o.name || c === 'sdcc'))) {
          error(m, `Flexible array member '${m.name}' needs another named member in '${ownerName}'.`);
        }
      }
      const inner = m.nestedStruct ?? (m.isNested && !m.type.includes('*') ? this.resolveStructTypeByName(m.type.replace(/^(struct|union)\s+/, '')) : undefined);
      if (c !== 'gcc' && inner && !inner.isUnion && inner.members.length > 0 && unsized(inner.members[inner.members.length - 1]!)) {
        error(m, `'${m.name}' is a struct ending in a flexible array member, which ${c === 'msvc' ? 'MSVC' : 'SDCC'} does not accept as a member.`);
      }
    });
  }

  /** `template < ... >`, nested angle brackets and parentheses included. */
  private skipTemplateHeader(): void {
    this.pos += 1;
    if (!this.isPunct('<')) this.fail("Expected '<' after 'template'.");
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      if (t.kind === 'punct' && (t.value === '(' || t.value === '[')) {
        this.pos = findClosing(this.tokens, this.pos) + 1;
        continue;
      }
      if (t.kind === 'punct' && t.value === '<') depth += 1;
      if (t.kind === 'punct' && t.value === '>') depth -= 1;
      if (t.kind === 'punct' && t.value === '>>') depth -= 2;
      this.pos += 1;
      if (depth <= 0) return;
    }
  }

  /**
   * A constructor or destructor of `owner`, if one starts here: record what it makes of the class
   * (user-declared, user-provided, explicit, virtual destructor) and skip it.
   */
  private parseConstructorOrDestructor(owner: ParsedStruct, close: number): boolean {
    const cpp = owner.cpp!;
    let k = 0;
    let isExplicit = false;
    let isVirtual = false;
    for (;;) {
      const t = this.peek(k);
      if (t?.kind !== 'id') break;
      if (t.value === 'explicit') {
        isExplicit = true;
        // C++20 conditional explicit: explicit(expr).
        if (this.isPunct('(', k + 1)) {
          k = findClosing(this.tokens, this.pos + k + 1) - this.pos + 1;
          continue;
        }
      } else if (t.value === 'virtual') {
        isVirtual = true;
      } else if (!['inline', 'constexpr', 'consteval', '__inline', '__forceinline'].includes(t.value)) {
        break;
      }
      k += 1;
    }
    const destructor = this.isPunct('~', k);
    const nameAt = destructor ? k + 1 : k;
    if (this.peek(nameAt)?.kind !== 'id' || this.peek(nameAt)!.value !== owner.name || !this.isPunct('(', nameAt + 1)) return false;

    const line = this.peek(nameAt)!.line;
    this.pos += nameAt + 1;
    const closeParen = findClosing(this.tokens, this.pos);
    if (closeParen === -1 || closeParen > close) this.fail(`Missing ')' in the ${destructor ? 'destructor' : 'constructor'} of '${owner.name}'.`, line);
    this.pos = closeParen + 1;
    while (this.peek()?.kind === 'id' && ['noexcept', 'throw', 'override', 'final'].includes(this.peek()!.value)) {
      this.pos += 1;
      if (this.isPunct('(')) this.pos = findClosing(this.tokens, this.pos) + 1;
    }
    const tail = this.parseFunctionTail();
    const provided = !tail.defaulted && !tail.deleted;
    if (destructor) {
      cpp.userDeclaredDestructor = true;
      if (provided) cpp.userProvidedDestructor = true;
      cpp.methods.push({ name: `~${owner.name}`, signature: '()', declaredVirtual: isVirtual, pure: tail.pure, destructor: true });
    } else {
      cpp.userDeclaredConstructor = true;
      if (provided) cpp.userProvidedConstructor = true;
      if (isExplicit) cpp.explicitConstructor = true;
    }
    if (!tail.body) this.endMember(close, owner.name, undefined);
    return true;
  }

  /**
   * What follows a function's declarator: `= default`, `= delete`, `= 0`, a body (after a
   * constructor's member initializers, or as a function-try-block), or nothing before its ';'.
   */
  private parseFunctionTail(): { defaulted: boolean; deleted: boolean; pure: boolean; body: boolean } {
    const tail = { defaulted: false, deleted: false, pure: false, body: false };
    if (this.isPunct('=')) {
      const v = this.peek(1)?.value;
      tail.defaulted = v === 'default';
      tail.deleted = v === 'delete';
      tail.pure = v === '0';
      this.pos += 1;
      this.takeUntil([',', ';']);
      return tail;
    }
    const tryBlock = this.isId('try');
    if (tryBlock) this.pos += 1;
    if (this.isPunct(':')) {
      // Member initializers, `name(args)` or `name{args}`, each perhaps a pack expansion (`...`).
      this.pos += 1;
      for (;;) {
        this.takeUntil(['(', '{', ';']);
        const end = this.isPunct('(') || this.isPunct('{') ? findClosing(this.tokens, this.pos) : -1;
        if (end === -1) break;
        this.pos = end + 1;
        if (this.isPunct('...')) this.pos += 1;
        if (!this.isPunct(',')) break;
        this.pos += 1;
      }
    }
    if (this.isPunct('{')) {
      this.pos = findClosing(this.tokens, this.pos) + 1;
      tail.body = true;
      while (tryBlock && this.isId('catch')) {
        this.pos += 1;
        if (this.isPunct('(')) this.pos = findClosing(this.tokens, this.pos) + 1;
        if (this.isPunct('{')) this.pos = findClosing(this.tokens, this.pos) + 1;
      }
    }
    return tail;
  }

  /**
   * A member function's parameter types and its own qualifiers, normalized as overriding compares
   * them: parameter names and default arguments dropped, typedefs resolved, arrays and functions
   * adjusted to pointers, top-level const dropped.
   */
  private methodSignature(func: Extract<Derivation, { kind: 'func' }>): string {
    const quals = func.quals.filter((q) => q === 'const' || q === 'volatile' || q === '&' || q === '&&').sort();
    return `(${this.parameterTypes(func.paramTokens).join(',')})${quals.length > 0 ? ` ${quals.join(' ')}` : ''}`;
  }

  private parameterTypes(tokens: readonly Token[]): string[] {
    const params: Token[][] = [[]];
    let depth = 0;
    for (const t of tokens) {
      if (t.kind === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{' || t.value === '<')) depth += 1;
      if (t.kind === 'punct' && (t.value === ')' || t.value === ']' || t.value === '}' || t.value === '>')) depth -= 1;
      if (t.kind === 'punct' && t.value === ',' && depth === 0) params.push([]);
      else params[params.length - 1].push(t);
    }
    if (params.length === 1 && (params[0].length === 0 || (params[0].length === 1 && params[0][0].value === 'void'))) return [];
    return params.map((p) => this.parameterType(p));
  }

  private parameterType(tokens: readonly Token[]): string {
    return this.nesting.in(() => this.parameterTypeAt(tokens), tokens[0]?.line);
  }

  /** parameterType, one parameter list deeper. */
  private parameterTypeAt(tokens: readonly Token[]): string {
    if (tokens.length === 1 && tokens[0].value === '...') return '...';
    // A default argument does not change the type.
    let depth = 0;
    const end = tokens.findIndex((t) => {
      if (t.kind === 'punct' && (t.value === '(' || t.value === '[' || t.value === '<')) depth += 1;
      if (t.kind === 'punct' && (t.value === ')' || t.value === ']' || t.value === '>')) depth -= 1;
      return depth === 0 && t.kind === 'punct' && t.value === '=';
    });
    const savedTokens = this.tokens;
    const savedPos = this.pos;
    this.tokens = (end >= 0 ? tokens.slice(0, end) : tokens) as Token[];
    this.pos = 0;
    try {
      const spec = this.parseSpecifiers(null, false);
      const decl = this.parseDeclarator(true);
      return this.spellType(spec, decl.derivations, true);
    } finally {
      this.tokens = savedTokens;
      this.pos = savedPos;
    }
  }

  /** A type written as specifiers and derivations (from the name outward), in one spelling per type. */
  private spellType(spec: Specifiers, derivations: readonly Derivation[], parameter: boolean): string {
    const base = spec.base;
    let name: string;
    if (!base) name = '?';
    else if (base.kind === 'builtin') name = canonicalBuiltin(base.words);
    else if (base.kind === 'record' || base.kind === 'enum') name = base.def?.name ?? base.tag ?? '';
    else if (base.kind === 'typeof') name = this.describeType(base.type);
    else name = this.typedefSpellings.get(base.name) ?? base.name;
    const spell = (k: number, topLevel: boolean): string => {
      const d = derivations[k];
      if (!d) return `${topLevel && parameter ? '' : [...spec.cv].sort().map((q) => `${q} `).join('')}${name}`;
      if (d.kind === 'ptr') {
        const cv = topLevel && parameter ? '' : (d.cv ?? []).slice().sort().map((q) => ` ${q}`).join('');
        return `${d.ref ?? (d.memberOf !== undefined ? `${d.memberOf}::*` : '*')}${cv}(${spell(k + 1, false)})`;
      }
      // A parameter of array or function type is a pointer (C11 6.7.6.3p7-8).
      if (d.kind === 'array') return `${topLevel && parameter ? '*' : `[${d.size ?? ''}]`}(${spell(k + 1, false)})`;
      return `${topLevel && parameter ? '*' : ''}fn(${this.parameterTypes(d.paramTokens).join(',')})(${spell(k + 1, false)})`;
    };
    return spell(0, true);
  }

  /** `operator=`'s parameter makes it the copy assignment of `className`: X, X&, const X&, volatile X&. */
  private isCopyAssignmentParameter(tokens: readonly Token[], className: string): boolean {
    const params = this.parameterTypes(tokens);
    if (params.length !== 1) return false;
    return new RegExp(`^(&\\()?((const |volatile )*)${className.replace(/\W/g, '\\$&')}\\)?$`).test(params[0]) && !params[0].startsWith('&&');
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
    const declared = spec.base!.kind === 'name' ? (info.isPointer || info.memberPointer ? info.declaredType ?? undefined : spec.base!.name) : info.declaredType;
    if (declared && declared !== info.type) member.declaredType = declared;

    if (decl.bitWidth !== undefined) {
      if (info.dims.length > 0 || info.isPointer || info.memberPointer) {
        this.fail(`Bit-field '${name || '(unnamed)'}' must have an integer type.`, decl.line);
      }
      member.bitField = decl.bitWidth;
      this.checkBitfieldWidth(info, name, decl.bitWidth, decl.line);
    }

    const aligned = this.requestedAlignment(spec.attrs, decl.attrs);
    if (aligned !== undefined) member.alignAttribute = aligned;
    if (decl.attrs.packed || spec.attrs.packed) member.packed = true;
    const first = decl.derivations[0];
    if (first?.kind === 'ptr' && first.ref) member.reference = true;
    const noUniqueAddress = decl.attrs.noUniqueAddress ?? spec.attrs.noUniqueAddress;
    if (noUniqueAddress) member.noUniqueAddress = noUniqueAddress;
    return member;
  }

  /**
   * A bit-field may not be wider than its type (C11 6.7.2.1p4): its bits, an enum's those of the
   * integer type it is laid out as; a _Bool's 1 under GCC and SDCC, its 8 under MSVC (measured).
   */
  private checkBitfieldWidth(info: TypeInfo, name: string, width: number, line: number): void {
    let bits: number;
    if ((info.type === '_Bool' || info.type === 'bool') && this.compiler !== 'msvc') {
      bits = 1;
    } else {
      try {
        bits = 8 * this.calculator.measure(this.measurable(info)).size;
      } catch (err) {
        if (err instanceof ConstExprError) return; // an incomplete type is reported where it is laid out
        throw err;
      }
    }
    if (width > bits) this.fail(`Bit-field '${name || '(unnamed)'}' is ${width} bits wide, more than its type '${this.describeType(info)}' has (${bits}).`, line);
  }

  /**
   * A member of type `info`. Records and enums are linked to their definitions now when `resolve`
   * is set, as measuring needs; members are linked at the end (resolveReferences), so a typedef
   * may name a record defined after it.
   */
  private memberOfType(info: TypeInfo, name: string, resolve: boolean): StructMember {
    const member: StructMember = { name, type: info.type };
    if (info.functionPointer) member.functionPointer = true;
    if (info.memberPointer) member.memberPointer = { ...info.memberPointer, inheritance: this.inheritanceModel(info.memberPointer.className) };
    if (info.dims.length > 0) {
      member.arrayDims = info.dims;
      member.arraySize = info.dims.reduce((a, b) => a * b, 1);
      if (info.flexible) member.flexible = true;
    }
    // An aligned typedef's own alignment, a pointer typedef's too (GCC and MSVC); a pointer to an
    // aligned typedef carries none, since applyDeclarator does not pass it on to a pointer.
    if (info.typeAlignment !== undefined) member.typeAlignment = info.typeAlignment;
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
    }
    return member;
  }

  /**
   * MSVC's inheritance model of the class a pointer to member names, where a member of that type
   * is declared, which fixes it for the class (CppClass.inheritanceModel): from its bases while it
   * is being defined, and 'unspecified' for good while it has no definition. A typedef of the
   * pointer type fixes nothing (measured with MSVC).
   */
  private inheritanceModel(className: string): MsInheritanceModel {
    const def = this.defining.find((d) => d.name === className) ?? this.resolveStructTypeByName(className);
    if (!def?.cpp) {
      this.usedIncomplete.add(this.structAliases.get(className) ?? className);
      return 'unspecified';
    }
    return (def.cpp.inheritanceModel ??= msInheritanceModel(def, this.defining.includes(def)));
  }

  /** The type of a laid-out member, to go on from it in `offsetof(T, a.b[2])`. */
  private typeOfMember(m: StructMember): TypeInfo {
    const isPointer = m.type.includes('*') && !m.memberPointer;
    return {
      type: m.type,
      ...(m.declaredType !== undefined && { declaredType: m.declaredType }),
      isPointer,
      ...(m.functionPointer && { functionPointer: true }),
      ...(m.memberPointer && { memberPointer: { className: m.memberPointer.className, function: m.memberPointer.function } }),
      dims: m.arrayDims ?? [],
      ...(m.flexible && { flexible: true }),
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
      v === 'typeof' || v === '__typeof__' || v === '__typeof' ||
      STANDARD_TYPEDEFS.has(v) ||
      (this.hasInt128 && INT128_TYPEDEFS.has(v)) ||
      this.typeAliases.has(v) || this.structAliases.has(v) || this.enumAliases.has(v) ||
      // C++: a class or enum is a type name without its keyword; so is the type of nullptr.
      (this.isCpp && (this.structs.has(v) || this.unions.has(v) || this.enums.has(v) || v === 'nullptr_t' || v === 'decltype'))
    );
  }

  /** A record or enum type that has no definition yet, which `sizeof` and friends cannot measure. */
  private requireComplete(info: TypeInfo): void {
    if (info.isPointer) return;
    if (info.flexible) throw new ConstExprError(`'${this.describeType(info)}' is an array of unknown size`);
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
    const enumType = info.enumType ?? (info.enumRef !== undefined ? this.resolveEnumTypeByName(info.enumRef) : undefined);
    if (enumType || info.enumRef !== undefined) {
      if (enumType?.underlyingType) return this.signedness({ type: enumType.underlyingType, isPointer: false, dims: [] });
      // GCC: unsigned when no value is negative; MSVC: int. Not measured for SDCC.
      if (this.compiler === 'msvc') return 'signed';
      if (this.compiler === 'gcc' && enumType) return enumType.members.every((m) => (m.value ?? 0) >= 0) ? 'unsigned' : 'signed';
      return undefined;
    }
    const type = info.type;
    if (type.startsWith('unsigned ') || ['char8_t', 'char16_t', 'char32_t'].includes(type)) return 'unsigned';
    if (['signed char', 'short', 'int', 'long', 'long long', '__int128'].includes(type)) return 'signed';
    const wchar = this.target.architecture.wcharSigned;
    if (type === 'wchar_t' && wchar !== undefined) return wchar ? 'signed' : 'unsigned';
    return STANDARD_TYPEDEFS.get(type) ?? INT128_TYPEDEFS.get(type);
  }

  /** The arithmetic type `info` is, for a cast: a floating type, or an integer type by its size and signedness. */
  private scalarType(info: TypeInfo): ScalarType {
    const t = info.type;
    if (info.isPointer || info.dims.length > 0 || info.recordRef || info.memberPointer || t === 'void' || t.endsWith('_Complex')) {
      throw new ConstExprError(`a cast to '${this.describeType(info)}' does not give an arithmetic value`);
    }
    if (t === 'float' || t === 'double' || t === 'long double') return { kind: 'float', name: t };
    const named = ['_Bool', 'bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long', '__int128', 'unsigned __int128'];
    if (named.includes(t) && info.enumRef === undefined) return { kind: 'int', type: integerType(this.integers, t) };
    // Any other integer type (a <stdint.h> type, an enum, wchar_t) is the standard one of its size and sign.
    const bits = 8 * this.calculator.measure(this.measurable(info)).size;
    const signedness = this.signedness(info);
    if (!signedness) throw new ConstExprError(`whether '${this.describeType(info)}' is signed on this target is not modelled`);
    const standard = ['char', 'short', 'int', 'long', 'long long', ...(this.hasInt128 ? ['__int128'] : [])].find((n) => integerType(this.integers, n).bits === bits);
    if (!standard) throw new ConstExprError(`'${this.describeType(info)}' has no integer type of its size here`);
    const name = signedness === 'unsigned' ? `unsigned ${standard}` : standard === 'char' ? 'signed char' : standard;
    return { kind: 'int', type: integerType(this.integers, name) };
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
      scalar: (info) => this.scalarType(info),
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
  // `_Complex` makes the type complex; alone it is `double _Complex`, as GCC takes it.
  const complex = has('_Complex') ? ' _Complex' : '';
  if (has('__int128')) return `${unsigned ? 'unsigned __int128' : '__int128'}${complex}`;
  if (has('float')) return `float${complex}`;
  if (has('double') || (complex && words.every((w) => w === '_Complex' || w === 'long'))) return `${longs > 0 ? 'long double' : 'double'}${complex}`;
  if (has('char')) return `${unsigned ? 'unsigned char' : signed ? 'signed char' : 'char'}${complex}`;
  const base = has('short') ? 'short' : longs >= 2 ? 'long long' : longs === 1 ? 'long' : 'int';
  return `${unsigned ? `unsigned ${base}` : base}${complex}`;
}
