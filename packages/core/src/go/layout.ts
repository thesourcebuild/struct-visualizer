/**
 * Go memory layout, following the gc compiler (go/types gcSizes):
 * - fields are laid out in declaration order (Go never reorders),
 * - a struct's alignment is its largest field alignment,
 * - "the last field of a non-zero-sized struct is not allowed to have size 0": a trailing
 *   zero-size field gets one byte, then the size is rounded up to the alignment.
 *
 * Also computes ptrdata (the prefix the garbage collector scans) and the field order the
 * `fieldalignment` analyzer (golang.org/x/tools) recommends.
 */
import type { CalculationResult, ParseError, ParsedStruct, StructMember } from '../types';
import { formatGoType, parseGo } from './parser';
import type { GoField, GoFile, GoType } from './parser';
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

export interface Scope {
  file: GoFile;
  /** Type parameter substitutions for an instantiated generic. */
  subst: Map<string, GoType>;
  /** Package path whose names are in scope (std definitions refer to siblings unqualified). */
  stdPackage?: string;
}

const stdCache = new Map<string, GoFile>();
function stdDecl(key: string): { type: GoType; align?: number; typeParams: string[] } | undefined {
  const entry = GO_STD_TYPES[key];
  if (!entry) return undefined;
  let file = stdCache.get(key);
  if (!file) {
    file = parseGo(`package std\ntype T ${entry.source}`);
    stdCache.set(key, file);
  }
  return { type: file.types.get('T')!.type, align: entry.align, typeParams: entry.typeParams ?? [] };
}

export class GoLayoutEngine {
  private visiting = new Set<string>();

  constructor(private target: GoTarget, private file: GoFile) {}

  private basic(name: string): Info | undefined {
    const w = this.target.wordSize;
    const m = this.target.maxAlign;
    const scalar = (size: number, align = size): Info => ({ size, align: Math.min(align, m), ptrdata: 0 });
    switch (name) {
      case 'bool': case 'int8': case 'uint8': case 'byte': return scalar(1);
      case 'int16': case 'uint16': return scalar(2);
      case 'int32': case 'uint32': case 'float32': case 'rune': return scalar(4);
      case 'int64': case 'uint64': return { ...scalar(8), int64: true };
      case 'float64': return scalar(8);
      // complex values are aligned like [2]float32 / [2]float64.
      case 'complex64': return scalar(8, 4);
      case 'complex128': return scalar(16, 8);
      case 'int': case 'uint': case 'uintptr': return scalar(w);
      case 'string': return { size: 2 * w, align: w, ptrdata: w };
      case 'any': case 'error': return { size: 2 * w, align: w, ptrdata: 2 * w };
      default: return undefined;
    }
  }

  info(type: GoType, scope: Scope, line?: number): Info {
    const w = this.target.wordSize;
    switch (type.kind) {
      case 'pointer': case 'map': case 'chan': case 'func':
        return { size: w, align: w, ptrdata: w };
      case 'slice':
        return { size: 3 * w, align: w, ptrdata: w };
      case 'interface':
        return { size: 2 * w, align: w, ptrdata: 2 * w };
      case 'array': {
        const elem = this.info(type.elem, scope, line);
        const size = elem.size * type.length;
        const ptrdata = type.length === 0 || elem.ptrdata === 0 ? 0 : (type.length - 1) * elem.size + elem.ptrdata;
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
    if (!type.pkg) {
      const sub = scope.subst.get(type.name);
      if (sub) return this.info(sub, { ...scope, subst: new Map() }, line);
    }
    if (type.pkg === 'unsafe' && type.name === 'Pointer') {
      const w = this.target.wordSize;
      return { size: w, align: w, ptrdata: w };
    }
    if (!type.pkg) {
      const b = this.basic(type.name);
      if (b) return b;
    }

    // A std type, either qualified (time.Time) or unqualified inside a std definition. Std
    // sources name sibling packages by short name (sync.Mutex inside sync.RWMutex).
    const stdPath = type.pkg
      ? scope.stdPackage !== undefined
        ? STD_PACKAGE_PATHS[type.pkg]
        : this.file.imports.get(type.pkg) ?? STD_PACKAGE_PATHS[type.pkg]
      : scope.stdPackage;
    if (stdPath !== undefined) {
      const std = stdDecl(`${stdPath}.${type.name}`);
      if (std) {
        const subst = new Map(std.typeParams.map((p, i) => [p, type.typeArgs?.[i] ?? ({ kind: 'name', name: 'any' } as GoType)]));
        const inner = this.info(std.type, { file: this.file, subst, stdPackage: stdPath }, line);
        if (std.align && std.align > inner.align) {
          const align = std.align;
          return { ...inner, align, size: alignUp(inner.size, align), struct: inner.struct && { ...inner.struct, struct: { ...inner.struct.struct, alignment: align } } };
        }
        return inner;
      }
    }
    if (type.pkg) {
      throw new LayoutError(
        stdPath === undefined
          ? `Unknown package '${type.pkg}' in '${formatGoType(type)}': add its import, or declare the type in the input.`
          : `Unknown type '${formatGoType(type)}': only common standard-library types are built in. Declare it in the input to lay it out.`,
        line,
      );
    }

    const decl = this.file.types.get(type.name);
    if (!decl || scope.stdPackage !== undefined) {
      throw new LayoutError(`Unknown type '${formatGoType(type)}'.`, line);
    }
    if (decl.typeParams.length > 0) {
      if (!type.typeArgs || type.typeArgs.length !== decl.typeParams.length) {
        throw new LayoutError(`Generic type '${decl.name}' needs ${decl.typeParams.length} type argument(s), e.g. ${decl.name}[${decl.typeParams.map(() => 'int').join(', ')}].`, line);
      }
    }
    const key = `${type.name}[${(type.typeArgs ?? []).map(formatGoType).join(',')}]`;
    if (this.visiting.has(key)) {
      throw new LayoutError(`Invalid recursive type '${type.name}': it contains itself by value (use a pointer).`, decl.line);
    }
    this.visiting.add(key);
    try {
      const subst = new Map(decl.typeParams.map((p, i) => [p, type.typeArgs![i]]));
      const inner = this.info(decl.type, { file: this.file, subst }, decl.line);
      if (inner.struct) inner.struct = { ...inner.struct, struct: { ...inner.struct.struct, name: type.name } };
      return inner;
    } finally {
      this.visiting.delete(key);
    }
  }

  /** Lay out struct fields in the given order with gc's rules. */
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

  /** The order golang.org/x/tools/go/analysis/passes/fieldalignment recommends. */
  optimalOrder(fields: readonly GoField[], scope: Scope): GoField[] {
    const elems = fields.map((f, index) => ({ f, index, ...this.info(f.type, scope, f.line) }));
    elems.sort((a, b) => {
      const za = a.size === 0;
      const zb = b.size === 0;
      if (za !== zb) return za ? -1 : 1; // zero-size first
      if (a.align !== b.align) return b.align - a.align; // tighter alignment first
      const na = a.ptrdata === 0;
      const nb = b.ptrdata === 0;
      if (na !== nb) return na ? 1 : -1; // pointerful before pointer-free
      if (!na) {
        const ta = a.size - a.ptrdata;
        const tb = b.size - b.ptrdata;
        if (ta !== tb) return ta - tb; // less trailing non-pointer data first
      }
      if (a.size !== b.size) return b.size - a.size;
      return a.index - b.index;
    });
    return elems.map((e) => e.f);
  }
}

/** ptrdata of each struct layout: the prefix up to the end of the last pointer. */
const structPtrdata = new WeakMap<CalculationResult, number>();

export interface GoAnalysis {
  target: GoTarget;
  file: GoFile;
  errors: ParseError[];
  warnings: ParseError[];
  /** The struct type being laid out: the last non-generic struct type declared. */
  definition: { name: string; line: number } | null;
  result: CalculationResult | null;
  optimized: CalculationResult | null;
  /** The root struct's fields as declared, and in the suggested order. */
  fields: GoField[];
  optimizedFields: GoField[];
  /** GC-scanned prefix ("pointer bytes"), as reported by fieldalignment. */
  pointerBytes: { current: number; optimized: number } | null;
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
    warnings: [...file.warnings],
    definition: null,
    result: null,
    optimized: null,
    fields: [],
    optimizedFields: [],
    pointerBytes: null,
    trailingZeroSizePadding: 0,
    unaligned64: [],
    unusedTypes: [],
  };
  if (analysis.errors.length > 0) return analysis;

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
  const scope: Scope = { file, subst: new Map() };
  const fields = (decl.type as Extract<GoType, { kind: 'struct' }>).fields;
  try {
    analysis.definition = { name: rootName, line: decl.line };
    analysis.fields = fields;
    analysis.optimizedFields = engine.optimalOrder(fields, scope);
    analysis.result = engine.layoutStruct(rootName, fields, scope);
    analysis.optimized = engine.layoutStruct(rootName, analysis.optimizedFields, scope);
    analysis.pointerBytes = {
      current: structPtrdata.get(analysis.result) ?? 0,
      optimized: structPtrdata.get(analysis.optimized) ?? 0,
    };
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
    if (!(err instanceof LayoutError)) throw err;
    analysis.errors.push({ message: err.message, line: err.line, type: 'semantic' });
    analysis.result = null;
    analysis.optimized = null;
  }
  return analysis;
}

/** Named types the root struct does not reference, directly or through pointers, slices, maps... */
function findUnusedTypes(file: GoFile, root: string): string[] {
  const used = new Set<string>();
  const visitType = (t: GoType) => {
    switch (t.kind) {
      case 'name':
        if (!t.pkg && file.types.has(t.name) && !used.has(t.name)) {
          used.add(t.name);
          visitType(file.types.get(t.name)!.type);
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
      default:
        return;
    }
  };
  used.add(root);
  visitType(file.types.get(root)!.type);
  return file.order.filter((n) => !used.has(n) && file.types.get(n)!.type.kind === 'struct');
}
