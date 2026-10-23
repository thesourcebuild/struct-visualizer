import type { CalculationResult, CppMethod, ParsedStruct, StructMember } from '../types';
import type { FieldPlacement, PaddingCalculator } from './padding-calculator';

/**
 * C++ class layout: base class subobjects, the pointer to the virtual function table, virtual
 * bases, the empty base optimization and tail padding, by the Itanium C++ ABI (GCC and Clang
 * outside Windows) or by MSVC's rules. Members are placed by the calculator's own field rules,
 * so a class with none of these is laid out exactly as the same struct in C.
 *
 * Both follow the structure of Clang's record layout builders, which implement the two ABIs, and
 * are checked against g++ and MSVC themselves in tests/cpp-compiler.test.ts.
 */

type Entry = CalculationResult['members'][number];

/** What laying out a class gives the classes built on it. */
interface ClassLayout {
  /** The complete object. */
  result: CalculationResult;
  size: number;
  align: number;
  /** The class as a base subobject: without its virtual bases. */
  nvSize: number;
  nvAlign: number;
  /** Itanium dsize: the end of the data, where a derived class may place its next member. */
  dataSize: number;
  /** Direct non-virtual bases. */
  baseOffsets: Map<ParsedStruct, number>;
  /** Every virtual base, in the complete object. */
  vbaseOffsets: Map<ParsedStruct, number>;
  fields: Array<{ member: StructMember; offset: number }>;
  primary?: { def: ParsedStruct; virtual: boolean };
  hasOwnVptr: boolean;
  // MSVC only.
  hasVbptr: boolean;
  vbptrOffset: number;
  extendableVfptr: boolean;
  leadsWithZeroSizedBase: boolean;
  endsWithZeroSizedObject: boolean;
  /** Alignment from __declspec(align) / alignas, which #pragma pack does not lower. */
  requiredAlignment: number;
  vtordisps: Set<ParsedStruct>;
}

/** A member function after overriding is worked out. */
interface ResolvedMethod extends CppMethod {
  owner: ParsedStruct;
  virtual: boolean;
  /** The virtual functions of base classes it overrides. */
  overrides: ResolvedMethod[];
}

const alignTo = (n: number, a: number) => Math.ceil(n / Math.max(1, a)) * Math.max(1, a);

export class CppLayout {
  private readonly layouts = new WeakMap<ParsedStruct, ClassLayout>();
  private readonly methods = new WeakMap<ParsedStruct, ResolvedMethod[]>();

  constructor(
    private readonly host: PaddingCalculator,
    private readonly abi: 'itanium' | 'msvc',
    private readonly pointerSize: number,
    private readonly pointerAlign: number,
  ) {}

  layout(def: ParsedStruct): CalculationResult {
    return this.layoutOf(def).result;
  }

  // ------------------------------------------------------------------ class facts

  private bases(def: ParsedStruct) {
    return def.cpp?.bases ?? [];
  }

  /** Its member functions, each marked virtual if declared so or if it overrides a base's virtual function. */
  private methodsOf(def: ParsedStruct): ResolvedMethod[] {
    let methods = this.methods.get(def);
    if (methods) return methods;
    methods = (def.cpp?.methods ?? []).map((m) => {
      const overrides = this.bases(def).flatMap((b) => this.overridden(b.def, m));
      return { ...m, owner: def, overrides, virtual: m.declaredVirtual || overrides.length > 0 };
    });
    this.methods.set(def, methods);
    return methods;
  }

  /** The virtual functions in `def` or (where it has none of its own) its bases that `m` overrides. */
  private overridden(def: ParsedStruct, m: CppMethod): ResolvedMethod[] {
    const own = this.methodsOf(def).filter((v) => v.virtual && (m.destructor ? v.destructor : !v.destructor && v.name === m.name && v.signature === m.signature));
    return own.length > 0 ? own : this.bases(def).flatMap((b) => this.overridden(b.def, m));
  }

  /** Has virtual functions, declared or inherited. */
  private polymorphic(def: ParsedStruct): boolean {
    return this.methodsOf(def).some((m) => m.virtual) || this.bases(def).some((b) => this.polymorphic(b.def));
  }

  private hasVirtualBases(def: ParsedStruct): boolean {
    return this.bases(def).some((b) => b.virtual || this.hasVirtualBases(b.def));
  }

  /** Needs a vptr somewhere: virtual functions or virtual bases (Itanium's dynamic class). */
  private dynamic(def: ParsedStruct): boolean {
    return this.polymorphic(def) || this.hasVirtualBases(def);
  }

  /** No data, no virtual functions or bases, only empty bases (C++'s is_empty). */
  isEmpty(def: ParsedStruct): boolean {
    if (def.isUnion) return def.members.every((m) => m.bitField === 0);
    return (
      def.members.every((m) => m.bitField === 0 && !m.name) &&
      !this.dynamic(def) &&
      this.bases(def).every((b) => this.isEmpty(b.def))
    );
  }

  /**
   * Itanium's "POD for the purpose of layout", whose tail padding a derived class may not reuse:
   * what makes g++ treat a class as not one, measured case by case (tests/cpp-compiler.test.ts).
   */
  private layoutPod(def: ParsedStruct): boolean {
    const c = def.cpp;
    if (!c) return true;
    if (this.bases(def).length > 0 || this.dynamic(def)) return false;
    if (c.userProvidedConstructor || c.explicitConstructor || (c.standard === 'c++20' && c.userDeclaredConstructor)) return false;
    if (c.userProvidedDestructor || c.userProvidedCopyAssignment) return false;
    if (c.nonPublicData || c.defaultMemberInitializer || c.referenceMember) return false;
    return def.members.every((m) => {
      const t = classType(m);
      return !t || this.layoutPod(t);
    });
  }

  /** Itanium: dynamic, with no data of its own beyond the vptr. */
  private nearlyEmpty(def: ParsedStruct): boolean {
    return this.dynamic(def) && this.layoutOf(def).nvSize === this.pointerSize;
  }

  /**
   * The virtual bases in the order MSVC lays them out, which is also C++'s initialization order:
   * each direct base's virtual bases before the base itself if it is virtual, each once.
   */
  private virtualBasesInOrder(def: ParsedStruct): ParsedStruct[] {
    const out: ParsedStruct[] = [];
    for (const b of this.bases(def)) {
      for (const v of this.virtualBasesInOrder(b.def)) if (!out.includes(v)) out.push(v);
      if (b.virtual && !out.includes(b.def)) out.push(b.def);
    }
    return out;
  }

  layoutOf(def: ParsedStruct): ClassLayout {
    let layout = this.layouts.get(def);
    if (!layout) {
      layout = this.abi === 'msvc' ? this.msvc(def) : this.itanium(def);
      this.layouts.set(def, layout);
    }
    return layout;
  }

  // ------------------------------------------------------------------ empty subobjects (Itanium)

  /**
   * The empty class subobjects inside a subobject of `def` at `offset`, with theirs: as a base
   * subobject without its virtual bases, as a complete object (a member) with them.
   */
  private *emptySubobjects(def: ParsedStruct, offset: number, complete: boolean): Generator<[ParsedStruct, number]> {
    if (!def.cpp) return;
    if (this.isEmpty(def)) yield [def, offset];
    const l = this.layoutOf(def);
    for (const [b, at] of l.baseOffsets) yield* this.emptySubobjects(b, offset + at, false);
    if (complete) for (const [v, at] of l.vbaseOffsets) yield* this.emptySubobjects(v, offset + at, false);
    for (const f of l.fields) {
      const t = classType(f.member);
      if (!t) continue;
      const element = this.layoutOf(t).size;
      for (let i = 0; i < Math.max(1, f.member.arraySize ?? 1); i++) yield* this.emptySubobjects(t, offset + f.offset + i * element, true);
    }
  }

  // ------------------------------------------------------------------ Itanium C++ ABI

  /** Itanium C++ ABI 2.4: primary base, vptr, non-virtual bases, members, then virtual bases. */
  private itanium(def: ParsedStruct): ClassLayout {
    const pragma = def.pragmaPack;
    const entries: Entry[] = [];
    const baseOffsets = new Map<ParsedStruct, number>();
    const vbaseOffsets = new Map<ParsedStruct, number>();
    /** Empty class subobjects placed so far, by offset: no two of a type may share an address. */
    const placed = new Map<number, Set<ParsedStruct>>();
    const canPlace = (t: ParsedStruct, at: number, complete: boolean) => {
      for (const [cls, off] of this.emptySubobjects(t, at, complete)) if (placed.get(off)?.has(cls)) return false;
      return true;
    };
    const add = (t: ParsedStruct, at: number, complete: boolean) => {
      for (const [cls, off] of this.emptySubobjects(t, at, complete)) {
        if (!placed.has(off)) placed.set(off, new Set());
        placed.get(off)!.add(cls);
      }
    };

    let size = 0;
    let dsize = 0;
    let align = 1;

    // The primary base shares the vptr: the first non-virtual dynamic base, or else a nearly empty
    // virtual base that is not some base's primary already.
    const dynamic = this.dynamic(def);
    let primary: { def: ParsedStruct; virtual: boolean } | undefined;
    const indirectPrimary = new Set<ParsedStruct>();
    if (dynamic) {
      this.indirectPrimaryBases(def, indirectPrimary);
      const nv = this.bases(def).find((b) => !b.virtual && this.dynamic(b.def));
      if (nv) primary = { def: nv.def, virtual: false };
      else if (this.hasVirtualBases(def)) {
        let firstNearlyEmpty: ParsedStruct | undefined;
        const select = (rd: ParsedStruct): ParsedStruct | undefined => {
          for (const b of this.bases(rd)) {
            if (b.virtual && this.nearlyEmpty(b.def)) {
              if (!indirectPrimary.has(b.def)) return b.def;
              firstNearlyEmpty ??= b.def;
            }
            const found = select(b.def);
            if (found) return found;
          }
          return undefined;
        };
        const v = select(def) ?? firstNearlyEmpty;
        if (v) primary = { def: v, virtual: true };
      }
    }

    /** Where a base goes: an empty one at 0 if it can share it, else the first free offset at its alignment. */
    const layoutBase = (b: ParsedStruct): number => {
      const bl = this.layoutOf(b);
      let baseAlign = bl.nvAlign;
      if (this.isEmpty(b) && canPlace(b, 0, false)) {
        size = Math.max(size, bl.size);
        align = Math.max(align, baseAlign);
        add(b, 0, false);
        return 0;
      }
      if (pragma !== undefined) baseAlign = Math.min(baseAlign, pragma);
      let offset = alignTo(dsize, baseAlign);
      while (!canPlace(b, offset, false)) offset += baseAlign;
      if (!this.isEmpty(b)) {
        dsize = offset + bl.nvSize;
        size = Math.max(size, dsize);
      } else {
        size = Math.max(size, offset + bl.size);
      }
      align = Math.max(align, baseAlign);
      add(b, offset, false);
      return offset;
    };
    const visited = new Set<ParsedStruct>();
    /** A base's virtual primary base shares the base's address and is not laid out again. */
    const claimPrimaryVirtualBases = (b: ParsedStruct, offset: number) => {
      const bl = this.layoutOf(b);
      if (bl.primary?.virtual && !vbaseOffsets.has(bl.primary.def)) {
        vbaseOffsets.set(bl.primary.def, offset);
        visited.add(bl.primary.def);
        claimPrimaryVirtualBases(bl.primary.def, offset);
      }
      for (const [nb, at] of bl.baseOffsets) claimPrimaryVirtualBases(nb, offset + at);
    };
    const pushBase = (b: ParsedStruct, offset: number, role: 'base' | 'virtual-base') => {
      const bl = this.layoutOf(b);
      entries.push(baseEntry(b, offset, role, bl, this.asBaseSubobject(bl)));
    };

    if (primary && !primary.virtual) {
      const offset = layoutBase(primary.def);
      baseOffsets.set(primary.def, offset);
      pushBase(primary.def, offset, 'base');
      claimPrimaryVirtualBases(primary.def, offset);
    } else if (primary) {
      indirectPrimary.add(primary.def);
      visited.add(primary.def);
      const offset = layoutBase(primary.def);
      vbaseOffsets.set(primary.def, offset);
      pushBase(primary.def, offset, 'virtual-base');
      claimPrimaryVirtualBases(primary.def, offset);
    } else if (dynamic) {
      let ptrAlign = def.packed ? 1 : this.pointerAlign;
      if (pragma !== undefined) ptrAlign = Math.min(ptrAlign, pragma);
      size = alignTo(size, ptrAlign) + this.pointerSize;
      dsize = size;
      align = Math.max(align, ptrAlign);
      entries.push(vptrEntry('vptr', 0, this.pointerSize, ptrAlign));
    }
    for (const b of this.bases(def)) {
      if (b.virtual || (primary && !primary.virtual && b.def === primary.def)) continue;
      const offset = layoutBase(b.def);
      baseOffsets.set(b.def, offset);
      pushBase(b.def, offset, 'base');
      claimPrimaryVirtualBases(b.def, offset);
    }

    // Members, from dsize on. A member of class type moves past empty subobjects of its types;
    // a [[no_unique_address]] one may overlap the rest, and an empty one takes no data.
    const state = this.host.startFields(dsize * 8);
    let paddedSize = 0;
    const place: FieldPlacement = (member, layout, at) => {
      const t = classType(member);
      if (!t) return { offset: at, dataEnd: at + layout.size };
      const tl = this.layoutOf(t);
      const count = Math.max(1, member.arraySize ?? 1);
      const fits = (offset: number) => {
        for (let i = 0; i < count; i++) if (!canPlace(t, offset + i * tl.size, true)) return false;
        return true;
      };
      const overlapping = member.noUniqueAddress === 'std' && member.arraySize === undefined;
      let offset = at;
      let dataEnd = at + layout.size;
      if (overlapping && this.isEmpty(t)) {
        const current = Math.ceil(state.pos / 8);
        offset = 0;
        while (!fits(offset)) offset = offset === 0 && current !== 0 ? alignTo(current, layout.alignment) : offset + layout.alignment;
        dataEnd = current;
      } else {
        while (!fits(offset)) offset += layout.alignment;
        dataEnd = offset + (overlapping ? Math.max(tl.nvSize, tl.dataSize) : layout.size);
      }
      for (let i = 0; i < count; i++) add(t, offset + i * tl.size, true);
      paddedSize = Math.max(paddedSize, offset + layout.size);
      return { offset, dataEnd };
    };
    for (const member of def.members) this.host.placeMember(state, member, def, place);
    this.host.closeFields(state);

    dsize = Math.ceil(state.pos / 8);
    size = Math.max(size, dsize);
    align = Math.max(align, state.maxAlignment);
    const nvAlign = this.host.structAlignment(def, align, state.maxExplicitAlignment);
    // As a base, the class ends with its data; a [[no_unique_address]] member's tail padding
    // still counts in its own size.
    let nvSize = size;
    size = Math.max(size, paddedSize);
    entries.push(...state.members);
    const fields = state.members.map((m) => ({ member: m.member, offset: m.offset }));

    // Virtual bases: in inheritance graph order, those not already some base's primary.
    const layoutVirtualBases = (rd: ParsedStruct) => {
      const rdPrimary = rd === def ? primary : this.layoutOf(rd).primary;
      for (const b of this.bases(rd)) {
        if (b.virtual && !(rdPrimary?.virtual && rdPrimary.def === b.def) && !indirectPrimary.has(b.def)) {
          if (visited.has(b.def)) continue;
          visited.add(b.def);
          const offset = layoutBase(b.def);
          vbaseOffsets.set(b.def, offset);
          pushBase(b.def, offset, 'virtual-base');
          claimPrimaryVirtualBases(b.def, offset);
        }
        if (this.hasVirtualBases(b.def)) layoutVirtualBases(b.def);
      }
    };
    layoutVirtualBases(def);

    size = Math.max(size, dsize);
    // C++ objects are at least one byte; a class with members of size 0 (zero-length arrays) is not.
    if (size === 0 && this.isEmpty(def)) size = 1;
    const finalAlign = this.host.structAlignment(def, align, state.maxExplicitAlignment);
    size = alignTo(size, finalAlign);

    // POD for layout: a derived class may not use its tail padding. An empty class keeps size 0
    // as a base, as g++ reports it ("base size=0"): the empty base optimization places it.
    let dataSize = dsize;
    if (this.layoutPod(def) && !this.isEmpty(def)) {
      dataSize = size;
      nvSize = size;
    }

    this.annotate(def, entries, primary?.def);
    const layout: ClassLayout = {
      result: buildResult(def, entries, size, finalAlign, nvSize, nvAlign, this.host),
      size,
      align: finalAlign,
      nvSize,
      nvAlign,
      dataSize,
      baseOffsets,
      vbaseOffsets,
      fields,
      primary,
      hasOwnVptr: dynamic && !primary,
      hasVbptr: false,
      vbptrOffset: -1,
      extendableVfptr: false,
      leadsWithZeroSizedBase: false,
      endsWithZeroSizedObject: false,
      requiredAlignment: 0,
      vtordisps: new Set(),
    };
    return layout;
  }

  /** Virtual bases that are some base's primary base, so share that base's address. */
  private indirectPrimaryBases(def: ParsedStruct, out: Set<ParsedStruct>): void {
    for (const b of this.bases(def)) {
      if (!this.hasVirtualBases(b.def)) continue;
      const bl = this.layoutOf(b.def);
      if (bl.primary?.virtual) out.add(bl.primary.def);
      this.indirectPrimaryBases(b.def, out);
    }
  }

  // ------------------------------------------------------------------ MSVC

  /**
   * MSVC: bases that carry a vfptr first, then the others, each after the previous (an empty base
   * has size 0 there and shares the next one's address); then the members; then the vbptr and the
   * vfptr are put in front of what they precede, moving it back; then the virtual bases, each
   * after a vtordisp where one is needed.
   */
  private msvc(def: ParsedStruct): ClassLayout {
    const pragma = def.pragmaPack;
    const usesEBO = def.cpp?.emptyBases === true;
    const ptrAlign = pragma !== undefined ? Math.min(this.pointerAlign, pragma) : this.pointerAlign;
    const entries: Entry[] = [];
    const baseOffsets = new Map<ParsedStruct, number>();
    const vbaseOffsets = new Map<ParsedStruct, number>();

    let size = 0;
    let align = 1;
    // 64-bit MSVC rounds the size up once more after the virtual bases; 32-bit does so only for an
    // explicit alignment (Clang's MicrosoftRecordLayoutBuilder starts RequiredAlignment at 1 and 0).
    let required = this.pointerSize === 8 ? 1 : 0;
    let leads = false;
    let ends = false;
    let previous: ClassLayout | undefined;
    let primary: ParsedStruct | undefined;
    let sharedVbptrBase: ParsedStruct | undefined;
    let hasVbptr = false;
    let hasPolymorphicBase = false;
    let vbptrOffset = 0;

    const elementAlignment = (l: ClassLayout) => {
      let a = l.align;
      if (pragma !== undefined) a = Math.min(a, pragma);
      ends = l.endsWithZeroSizedObject;
      align = Math.max(align, a);
      required = Math.max(required, l.requiredAlignment);
      return Math.max(a, l.requiredAlignment);
    };
    const layoutNonVirtualBase = (b: ParsedStruct) => {
      const bl = this.layoutOf(b);
      // A byte between a base ending in a zero-sized object and one starting with a zero-sized base.
      if (previous?.endsWithZeroSizedObject && bl.leadsWithZeroSizedBase && !usesEBO) size += 1;
      const a = elementAlignment(bl);
      let offset: number;
      if (usesEBO && this.isEmpty(b)) offset = 0;
      else offset = size = alignTo(size, a);
      baseOffsets.set(b, offset);
      size += bl.nvSize;
      previous = bl;
    };

    for (const b of this.bases(def)) {
      hasPolymorphicBase ||= this.polymorphic(b.def);
      if (b.virtual) {
        hasVbptr = true;
        continue;
      }
      const bl = this.layoutOf(b.def);
      if (!sharedVbptrBase && bl.hasVbptr) {
        sharedVbptrBase = b.def;
        hasVbptr = true;
      }
      if (!bl.extendableVfptr) continue;
      if (!primary) {
        primary = b.def;
        leads = bl.leadsWithZeroSizedBase;
      }
      layoutNonVirtualBase(b.def);
    }
    let hasOwnVfptr = false;
    if (this.polymorphic(def)) {
      // A class with polymorphic bases it cannot extend needs its own vfptr only for new virtual functions.
      if (!hasPolymorphicBase) hasOwnVfptr = true;
      else if (!primary) hasOwnVfptr = this.methodsOf(def).some((m) => m.virtual && m.overrides.length === 0);
    }
    let checkLeading = !primary;
    for (const b of this.bases(def)) {
      if (b.virtual) continue;
      const bl = this.layoutOf(b.def);
      if (bl.extendableVfptr) {
        vbptrOffset = baseOffsets.get(b.def)! + bl.nvSize;
        continue;
      }
      if (checkLeading) {
        checkLeading = false;
        leads = bl.leadsWithZeroSizedBase;
      }
      layoutNonVirtualBase(b.def);
      vbptrOffset = baseOffsets.get(b.def)! + bl.nvSize;
    }
    const hasOwnVbptr = hasVbptr && !sharedVbptrBase;
    if (!hasVbptr) vbptrOffset = -1;
    else if (sharedVbptrBase) vbptrOffset = baseOffsets.get(sharedVbptrBase)! + this.layoutOf(sharedVbptrBase).vbptrOffset;

    // Members. A [[msvc::no_unique_address]] member of empty class type overlaps the others, at the
    // first offset no other member of its type has, and takes no space.
    const state = this.host.startFields(size * 8);
    const overlapping = new Map<number, Set<ParsedStruct>>();
    const place: FieldPlacement = (member, layout, at) => {
      const t = classType(member);
      if (t && member.noUniqueAddress === 'msvc' && member.arraySize === undefined && this.isEmpty(t)) {
        let offset = 0;
        while (overlapping.get(offset)?.has(t)) offset += layout.alignment;
        if (!overlapping.has(offset)) overlapping.set(offset, new Set());
        overlapping.get(offset)!.add(t);
        return { offset, dataEnd: Math.ceil(state.pos / 8) };
      }
      ends = t ? this.layoutOf(t).endsWithZeroSizedObject : false;
      return { offset: at, dataEnd: at + layout.size };
    };
    for (const member of def.members) this.host.placeMember(state, member, def, place);
    this.host.closeFields(state);
    size = Math.max(size, Math.ceil(state.pos / 8));
    align = Math.max(align, state.maxAlignment);
    required = Math.max(required, state.required);
    const fieldEntries = state.members;

    const shiftFields = (by: number) => {
      for (const m of fieldEntries) {
        m.offset += by;
        if (m.bitOffset !== undefined) m.bitOffset += by * 8;
      }
    };
    if (hasOwnVbptr) {
      const site = vbptrOffset;
      vbptrOffset = alignTo(vbptrOffset, ptrAlign);
      const shift = alignTo(vbptrOffset + this.pointerSize - site, Math.max(required, align));
      size += shift;
      shiftFields(shift);
      for (const [b, at] of baseOffsets) if (at >= site) baseOffsets.set(b, at + shift);
    }
    if (hasOwnVfptr) {
      const shift = alignTo(this.pointerSize, Math.max(required, align));
      if (hasVbptr) vbptrOffset += shift;
      size += shift;
      shiftFields(shift);
      for (const [b, at] of baseOffsets) baseOffsets.set(b, at + shift);
    }
    if (hasOwnVfptr || hasOwnVbptr) align = Math.max(align, ptrAlign);
    size = alignTo(size, pragma !== undefined ? Math.min(align, pragma) : align);
    const nvSize = size;
    const nvAlign = align;
    if (def.alignAttribute !== undefined) required = Math.max(required, this.host.resolveAlignRequest(def.alignAttribute));

    if (hasOwnVfptr) entries.push(vptrEntry('vptr', 0, this.pointerSize, ptrAlign));
    if (hasOwnVbptr) entries.push(vptrEntry('vbptr', vbptrOffset, this.pointerSize, ptrAlign));
    for (const [b, at] of baseOffsets) entries.push(baseEntry(b, at, 'base', this.layoutOf(b), this.asBaseSubobject(this.layoutOf(b))));
    entries.push(...fieldEntries);
    const fields = fieldEntries.map((m) => ({ member: m.member, offset: m.offset }));

    // Virtual bases.
    const vtordisps = new Set<ParsedStruct>();
    if (hasVbptr) {
      const vbases = this.virtualBasesInOrder(def);
      for (const v of vbases) required = Math.max(required, this.layoutOf(v).requiredAlignment);
      const vtordispSize = 4;
      const vtordispAlign = Math.max(pragma !== undefined ? Math.min(4, pragma) : 4, required);
      for (const v of this.vtordispSet(def)) vtordisps.add(v);
      let previousVbase: ClassLayout | undefined;
      for (const v of vbases) {
        const vl = this.layoutOf(v);
        if (previousVbase?.endsWithZeroSizedObject && vl.leadsWithZeroSizedBase && !usesEBO) size = alignTo(size, vtordispAlign) + vtordispSize;
        if (vtordisps.has(v)) size = alignTo(size, vtordispAlign) + vtordispSize;
        const a = elementAlignment(vl);
        const offset = alignTo(size, a);
        // The vtordisp is the 4 bytes just before its virtual base.
        if (vtordisps.has(v)) entries.push(vptrEntry('vtordisp', offset - vtordispSize, vtordispSize, vtordispAlign, v));
        vbaseOffsets.set(v, offset);
        entries.push(baseEntry(v, offset, 'virtual-base', vl, this.asBaseSubobject(vl)));
        size = offset + vl.nvSize;
        previousVbase = vl;
      }
    }

    // Required alignment rounds the size whatever #pragma pack says; an empty class has size 1 or
    // its required alignment.
    if (required > 0) {
      align = Math.max(align, required);
      let rounding = pragma !== undefined ? Math.min(align, pragma) : align;
      rounding = Math.max(rounding, required);
      size = alignTo(size, rounding);
    }
    if (size === 0) {
      if (!usesEBO || !this.isEmpty(def)) {
        ends = true;
        leads = true;
      }
      size = required >= 1 ? align : 1;
    }

    this.annotate(def, entries, primary);
    return {
      result: { ...buildResult(def, entries, size, align, nvSize, nvAlign, this.host), ...(required > 0 && { requiredAlignment: required }) },
      size,
      align,
      nvSize,
      nvAlign,
      dataSize: nvSize,
      baseOffsets,
      vbaseOffsets,
      fields,
      ...(primary && { primary: { def: primary, virtual: false } }),
      hasOwnVptr: hasOwnVfptr,
      hasVbptr,
      vbptrOffset,
      extendableVfptr: hasOwnVfptr || (primary !== undefined && this.layoutOf(primary).extendableVfptr),
      leadsWithZeroSizedBase: leads,
      endsWithZeroSizedObject: ends,
      requiredAlignment: required,
      vtordisps,
    };
  }

  /**
   * The virtual bases that get a vtordisp (MSVC's default /vd1): those its bases already give one,
   * and, when the class declares a constructor or destructor, those whose virtual functions it
   * overrides (directly or through their non-virtual bases).
   */
  private vtordispSet(def: ParsedStruct): Set<ParsedStruct> {
    const set = new Set<ParsedStruct>();
    for (const b of this.bases(def)) for (const v of this.layoutOf(b.def).vtordisps) set.add(v);
    const c = def.cpp;
    if (!c || (!c.userDeclaredConstructor && !c.userDeclaredDestructor)) return set;
    // The classes that introduced the virtual functions this class overrides.
    const introducers = new Set<ParsedStruct>();
    const visit = (m: ResolvedMethod) => {
      if (m.overrides.length === 0) introducers.add(m.owner);
      else m.overrides.forEach(visit);
    };
    for (const m of this.methodsOf(def)) if (m.virtual && !m.destructor && !m.pure) visit(m);
    const requires = (rd: ParsedStruct): boolean => introducers.has(rd) || this.bases(rd).some((b) => !b.virtual && requires(b.def));
    for (const v of this.virtualBasesInOrder(def)) if (requires(v)) set.add(v);
    return set;
  }

  // ------------------------------------------------------------------ results

  /** Say why each subobject C's rule does not explain is where it is (Entry.note). */
  private annotate(def: ParsedStruct, entries: Entry[], primary: ParsedStruct | undefined): void {
    const msvc = this.abi === 'msvc';
    const bases = entries.filter((e) => e.member.role === 'base');
    for (const e of entries) {
      const role = e.member.role;
      const t = e.member.nestedStruct;
      if (role === 'vptr') {
        e.note = msvc
          ? 'The pointer to the virtual function table (vfptr): MSVC puts the class\'s own first, and moves everything after it back.'
          : 'The pointer to the virtual function table (vptr): a class with virtual functions or virtual bases starts with one, unless a primary base already has it.';
      } else if (role === 'vbptr') {
        e.note = 'The pointer to the virtual base table (vbptr): MSVC puts it after the non-virtual bases, and moves what follows back.';
      } else if (role === 'vtordisp') {
        e.note = 'A vtordisp: 4 bytes MSVC keeps just before a virtual base whose virtual functions the class overrides, when it declares a constructor or destructor.';
      } else if (role === 'base' && t) {
        if (this.isEmpty(t)) {
          e.note = msvc
            ? def.cpp?.emptyBases
              ? 'An empty base: with __declspec(empty_bases) it takes no space, at offset 0.'
              : 'An empty base: it has size 0 under MSVC, and shares its address with what follows (a byte goes between two of them in a row).'
            : e.offset === 0
              ? 'An empty base: it has no data, so it takes no space at offset 0 (the empty base optimization).'
              : 'An empty base: another subobject of its type is at offset 0 already, and two objects of one type need different addresses, so it goes at the next free offset.';
        } else if (t === primary) {
          e.note = 'The primary base: the class shares its vptr, so it comes first, at offset 0.';
        } else {
          e.note = 'A base class: bases come before the members, each at the next offset its alignment allows.';
        }
      } else if (role === 'virtual-base') {
        e.note = t === primary
          ? 'The primary virtual base: nearly empty (only a vptr), so the class shares that vptr with it, at offset 0.'
          : msvc
            ? 'A virtual base: one subobject shared by every path to it, after the non-virtual part; the vbptr says where.'
            : 'A virtual base: one subobject shared by every path to it, after the non-virtual part; the vptr\'s table says where.';
      } else if (!role && !msvc) {
        const t2 = classType(e.member);
        if (t2 && e.member.noUniqueAddress === 'std' && this.isEmpty(t2)) {
          e.note = '[[no_unique_address]] on a member of empty type: it takes no space, and shares its address with other members.';
          continue;
        }
        const tail = bases.find((b) => b.member.nestedStruct && e.offset >= b.offset + b.size && e.offset < b.offset + this.layoutOf(b.member.nestedStruct).size);
        if (tail) {
          e.note = `In the tail padding of base ${tail.member.name}: it is not POD for layout, so the Itanium ABI lets the derived class use it.`;
        }
      }
    }
  }

  /** A class's layout as a base subobject of another: without its virtual bases, nvSize long. */
  private asBaseSubobject(l: ClassLayout): CalculationResult {
    const members = l.result.members.filter((m) => m.member.role !== 'virtual-base' && !(m.member.role === 'vtordisp'));
    return withPadding({ ...l.result, members }, l.nvSize);
  }
}

/** The class a member is an object of (or an array of), for C++ classes. */
function classType(m: StructMember): ParsedStruct | undefined {
  return m.isNested && m.nestedStruct?.cpp && !m.type.includes('*') && !m.reference ? m.nestedStruct : undefined;
}

function baseEntry(def: ParsedStruct, offset: number, role: 'base' | 'virtual-base', l: ClassLayout, nested: CalculationResult): Entry {
  const keyword = def.cpp?.key ?? 'struct';
  return {
    member: { name: def.name, type: `${keyword} ${def.name}`, role, isNested: true, nestedStruct: def },
    offset,
    size: l.nvSize,
    padding: 0,
    alignment: l.nvAlign,
    nested,
  };
}

function vptrEntry(role: 'vptr' | 'vbptr' | 'vtordisp', offset: number, size: number, alignment: number, vbase?: ParsedStruct): Entry {
  const name = role === 'vtordisp' ? `vtordisp for ${vbase?.name ?? ''}` : role === 'vptr' ? 'vptr' : 'vbptr';
  return { member: { name, type: role === 'vtordisp' ? 'int' : 'void*', role }, offset, size, padding: 0, alignment };
}

/** Recompute each entry's padding (the gap before it) and the trailing padding, in offset order. */
function withPadding(result: CalculationResult, totalSize: number): CalculationResult {
  const sorted = result.members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (a.m.bitOffset ?? a.m.offset * 8) - (b.m.bitOffset ?? b.m.offset * 8) || a.i - b.i)
    .map(({ m }) => m);
  let end = 0;
  const members = sorted.map((m) => {
    const start = m.bitOffset ?? m.offset * 8;
    const stop = m.bitOffset !== undefined && m.member.bitField !== undefined ? start + m.member.bitField : (m.offset + m.size) * 8;
    const padding = Math.max(0, Math.floor(start / 8) - Math.ceil(end / 8));
    end = Math.max(end, stop);
    return { ...m, padding };
  });
  const trailing = Math.max(0, totalSize - Math.ceil(end / 8));
  const totalPadding = members.reduce((s, m) => s + m.padding, 0) + trailing;
  return {
    ...result,
    members,
    totalSize,
    totalPadding,
    wastedSpace: totalPadding,
    efficiency: totalSize > 0 ? ((totalSize - totalPadding) / totalSize) * 100 : 0,
    struct: { ...result.struct, totalSize, totalPadding },
  };
}

function buildResult(def: ParsedStruct, entries: Entry[], size: number, align: number, baseSize: number, baseAlignment: number, host: PaddingCalculator): CalculationResult {
  return withPadding(
    {
      struct: { ...def, totalSize: size, alignment: align, totalPadding: 0 },
      members: entries,
      totalSize: size,
      totalPadding: 0,
      wastedSpace: 0,
      efficiency: 0,
      architecture: host.architectureName,
      baseSize,
      baseAlignment,
    },
    size,
  );
}

