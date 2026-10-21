import type { AlignRequest, Architecture, ParsedStruct, StructMember, CalculationResult, ParsedEnum } from '../types';
import { dataModels, getStandardTypeMap } from '../abi/data-models';
import type { DataModel } from '../abi/data-models';

/** The most alignment packing leaves a member of `struct`: 1 when packed, else #pragma pack's n. */
function packingCap(struct: ParsedStruct): number | undefined {
  return struct.packed ? 1 : struct.pragmaPack;
}

/** The fewest of 1, 2, 4 or 8 bytes whose integer holds every value: unsigned when none is negative. */
function bytesForValues(values: readonly number[]): number {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const fits = (bytes: number) =>
    lo >= 0 ? hi < 2 ** (8 * bytes) : lo >= -(2 ** (8 * bytes - 1)) && hi < 2 ** (8 * bytes - 1);
  return [1, 2, 4].find(fits) ?? 8;
}

/** `bit` rounded up to the next multiple of `alignment` bytes. */
function roundUpBits(bit: number, alignment: number): number {
  const unit = Math.max(1, alignment) * 8;
  return Math.ceil(bit / unit) * unit;
}

interface MemberInfo {
  size: number;
  alignment: number;
  nested?: CalculationResult;
}

export class PaddingCalculator {
  private architecture: Architecture & {
    pointerSize: number;
    defaultAlignment: number;
    packingRules: NonNullable<Architecture['packingRules']>;
  };
  private dataModel: DataModel;
  private unknownTypes = new Set<string>();

  /** Types that fell back to the 4-byte size/alignment default during any calculation so far. */
  getUnknownTypes(): string[] {
    return [...this.unknownTypes];
  }

  constructor(architecture: Architecture, dataModel: DataModel = 'ILP32') {
    this.dataModel = dataModel;
    const modelPointerSize = dataModels[dataModel]?.dataTypes.pointerSize;
    const pointerSize = architecture.pointerSize ?? modelPointerSize ?? 8;
    const defaultAlignment = architecture.defaultAlignment ?? pointerSize;
    this.architecture = {
      ...architecture,
      pointerSize,
      defaultAlignment,
      packingRules: architecture.packingRules ?? {
        structAlignment: 'max',
        paddingAlignment: true,
      },
    };
  }

  /**
   * Lay out a struct or union. `packed` simulates `__attribute__((packed))` on every struct
   * (alignment 1); otherwise the definition's own `#pragma pack` / attributes apply.
   */
  calculate(struct: ParsedStruct, options?: { packed?: boolean }): CalculationResult {
    const isPacked = options?.packed === true;
    return struct.isUnion === true ? this.calculateUnion(struct, isPacked) : this.calculateStruct(struct, isPacked);
  }

  /**
   * Lay out a struct. Positions are tracked in bits so that bit-fields can be placed exactly; a
   * member that is not a bit-field always starts on a byte, at the first one its alignment allows.
   *
   * Bit-fields follow the target compiler's rules (`bitfieldLayout`), both checked against the
   * compilers in tests/cross-compiler.test.ts:
   * - 'gcc' (GCC and Clang outside Windows): a field goes at the next free bit unless that would
   *   make it span more units of its type's alignment than its type has, in which case it moves to
   *   the next such boundary. Under `packed` or any `#pragma pack` that check is skipped.
   * - 'ms' (MSVC, and MinGW's default -mms-bitfields): a field opens a storage unit of its type's
   *   size, aligned like the type, unless the previous member is a bit-field of a type of the same
   *   size whose unit still has room.
   *
   * Padding is what no member occupies: the bytes between the end of one member's bits and the
   * byte where the next member starts, and the trailing bytes up to the struct's alignment.
   */
  /**
   * Lay out a struct. Positions are tracked in bits so that bit-fields can be placed exactly; a
   * member that is not a bit-field always starts on a byte, at the first one its alignment allows.
   *
   * Bit-fields follow the target compiler's rules (`bitfieldLayout`), each checked against the
   * compiler in tests/cross-compiler.test.ts:
   * - 'gcc' (GCC and Clang outside Windows): a field goes at the next free bit. On targets where
   *   the field's type matters (GCC's PCC_BITFIELD_TYPE_MATTERS, all but AVR here) it moves to the
   *   next boundary of its type's alignment if it would otherwise span more of those units than
   *   its type has; `packed` or any `#pragma pack` lifts that rule.
   * - 'ms' (MSVC, and MinGW's default -mms-bitfields): a field opens a storage unit of its type's
   *   size, aligned like the type, unless the previous member is a bit-field of a type of the same
   *   size whose unit still has room.
   * - 'sdcc': a field goes at the next free bit if it fits in what is left of the current byte,
   *   and otherwise starts at the next byte.
   *
   * Padding is what no member occupies: the bytes between the end of one member's bits and the
   * byte where the next member starts, and the trailing bytes up to the struct's alignment.
   */
  private calculateStruct(struct: ParsedStruct, isPacked: boolean): CalculationResult {
    const members: CalculationResult['members'] = [];
    const rules = this.architecture.bitfieldLayout;
    /** Next free bit. */
    let pos = 0;
    /** First bit after the last member placed: `pos` without the rest of an MS storage unit. */
    let end = 0;
    let maxAlignment = 1;
    // Alignment that neither #pragma pack, packed nor the target cap lowers: aligned/alignas
    // requests, and what zero-width bit-fields add where the compiler exempts them from packing.
    let maxExplicitAlignment = 1;
    /** The open MS storage unit: where it starts, its size in bytes, and the bits used. */
    let unit: { start: number; bytes: number; used: number } | null = null;

    const closeUnit = () => {
      if (unit) pos = unit.start + unit.bytes * 8;
      unit = null;
    };
    const gapBefore = (bit: number) => Math.max(0, Math.floor(bit / 8) - Math.ceil(end / 8));

    for (const member of struct.members) {
      if (member.bitField !== undefined) {
        const width = Math.max(0, member.bitField);
        const typeInfo = this.bitfieldTypeInfo(member);
        const typeAlign = Math.max(1, typeInfo.alignment);
        const packed = isPacked || struct.packed === true || member.packed === true;
        const pragma = struct.pragmaPack;
        const explicit = member.alignAttribute !== undefined ? this.resolveAlignRequest(member.alignAttribute) : undefined;
        /** The type's alignment under #pragma pack, which packed does not lower. */
        const pragmaAlign = pragma !== undefined ? Math.min(typeAlign, pragma) : typeAlign;
        let start: number;
        let alignment: number;

        if (rules === 'ms') {
          // The unit's alignment, as for any member: 1 when packed, capped by #pragma pack.
          alignment = this.effectiveAlignment(member, typeAlign, struct, isPacked);
          if (width === 0) {
            // A zero-width bit-field only counts directly after a bit-field. It closes that unit,
            // moves what follows to its type's alignment unless packed, and raises the struct's
            // alignment to it even when packed (MSVC; MinGW agrees).
            const afterBitfield = unit !== null;
            closeUnit();
            if (afterBitfield) {
              pos = roundUpBits(pos, packed ? 1 : pragmaAlign);
              maxExplicitAlignment = Math.max(maxExplicitAlignment, pragmaAlign);
            }
            alignment = pragmaAlign;
            start = pos;
          } else {
            const shares = unit !== null && unit.bytes === typeInfo.size && unit.used + width <= unit.bytes * 8;
            if (!shares) {
              closeUnit();
              pos = roundUpBits(pos, alignment);
              unit = { start: pos, bytes: typeInfo.size, used: 0 };
            }
            const open = unit!;
            start = open.start + open.used;
            open.used += width;
            pos = start + width;
            // Named or not, the field's type sets the struct's alignment.
            maxAlignment = Math.max(maxAlignment, alignment);
            if (explicit !== undefined) maxExplicitAlignment = Math.max(maxExplicitAlignment, alignment);
          }
        } else if (rules === 'sdcc') {
          // All types are byte-aligned on SDCC's 8-bit targets.
          alignment = 1;
          if (width === 0) {
            pos = roundUpBits(pos, 1);
          } else if (pos % 8 !== 0 && width > 8 - (pos % 8)) {
            pos = roundUpBits(pos, 1);
          }
          start = pos;
          pos += width;
        } else {
          const typeMatters = this.architecture.bitfieldTypeMatters !== false;
          if (width === 0) {
            // A zero-width bit-field moves the next field to its type's alignment (to the next
            // byte where the type does not matter); neither #pragma pack nor packed changes that,
            // nor what it adds to the struct's alignment where unnamed fields count (layout_decl).
            alignment = typeMatters ? typeAlign : 1;
            pos = roundUpBits(pos, alignment);
            if (typeMatters && this.architecture.alignUnnamedBitfields) {
              maxExplicitAlignment = Math.max(maxExplicitAlignment, alignment);
            }
          } else {
            if (explicit !== undefined) pos = roundUpBits(pos, explicit);
            // A bit-field may not span more units of its type's alignment than its type does
            // (GCC's excess_unit_span); packing of any kind lifts the rule.
            const unitBits = typeAlign * 8;
            const spans = Math.floor(((pos % unitBits) + width + unitBits - 1) / unitBits);
            const bitPacked = packed || pragma !== undefined;
            if (typeMatters && !bitPacked && spans > Math.floor((typeInfo.size * 8) / unitBits)) {
              pos = roundUpBits(pos, typeAlign);
            }
            // What the field adds to the struct's alignment: its type's, capped by #pragma pack, or
            // 1 when packed; raised by an explicit request. Unnamed fields add nothing unless the
            // target says so (ARM).
            alignment = !typeMatters ? 1 : pragma !== undefined ? pragmaAlign : packed ? 1 : typeAlign;
            if (explicit !== undefined) alignment = Math.max(alignment, explicit);
            if (member.name || this.architecture.alignUnnamedBitfields) {
              maxAlignment = Math.max(maxAlignment, alignment);
              if (explicit !== undefined) maxExplicitAlignment = Math.max(maxExplicitAlignment, alignment);
            }
          }
          start = pos;
          pos += width;
        }

        const offset = Math.floor(start / 8);
        const size = width === 0 ? 0 : Math.floor((start + width - 1) / 8) - offset + 1;
        members.push({ member, offset, size, padding: gapBefore(start), alignment, bitOffset: start });
        end = Math.max(end, start + width);
        continue;
      }

      closeUnit();
      const { size, alignment, nested } = this.memberLayout(member, struct, isPacked);
      maxAlignment = Math.max(maxAlignment, alignment);
      if (member.alignAttribute !== undefined) maxExplicitAlignment = Math.max(maxExplicitAlignment, alignment);

      const offset = Math.ceil(pos / 8) + this.calculatePadding(Math.ceil(pos / 8), alignment);
      members.push({ member, offset, size, padding: gapBefore(offset * 8), alignment, nested });
      pos = (offset + size) * 8;
      end = pos;
    }

    closeUnit();

    // Trailing padding rounds the size up to the struct's alignment.
    const structAlignment = this.structAlignment(struct, maxAlignment, maxExplicitAlignment, isPacked);
    const used = Math.ceil(pos / 8);
    const totalSize = used + this.calculatePadding(used, structAlignment);
    const trailingPadding = totalSize - Math.ceil(end / 8);

    const totalPadding = members.reduce((sum, m) => sum + m.padding, 0) + trailingPadding;
    const dataSize = totalSize - totalPadding;
    const efficiency = dataSize > 0 ? (dataSize / totalSize) * 100 : 0;

    return {
      struct: {
        ...struct,
        totalSize,
        alignment: structAlignment,
        totalPadding,
      },
      members,
      totalSize,
      totalPadding,
      wastedSpace: totalPadding,
      efficiency,
      architecture: this.architecture.name,
    };
  }

  private calculateUnion(struct: ParsedStruct, isPacked: boolean): CalculationResult {
    // Every member starts at offset 0; the size is the largest member, rounded up.
    const members: CalculationResult['members'] = [];
    let maxSize = 0;
    let maxAlignment = 1;
    let maxExplicitAlignment = 1;

    for (const member of struct.members) {
      const { size, alignment, nested } = this.memberLayout(member, struct, isPacked);

      maxSize = Math.max(maxSize, size);
      // As in a struct, an unnamed bit-field adds no alignment under GCC's rules unless the
      // target says so; under MSVC's it does.
      const unnamedBitfield = member.bitField !== undefined && !member.name;
      if (!unnamedBitfield || this.architecture.bitfieldLayout === 'ms' || this.architecture.alignUnnamedBitfields) {
        maxAlignment = Math.max(maxAlignment, alignment);
      }
      if (member.alignAttribute !== undefined) maxExplicitAlignment = Math.max(maxExplicitAlignment, alignment);

      members.push({
        member,
        offset: 0,
        size,
        padding: 0,
        alignment,
        nested,
        ...(member.bitField !== undefined && { bitOffset: 0 }),
      });
    }

    let unionAlignment = isPacked ? 1 : Math.min(maxAlignment, this.architecture.maxAlignment || maxAlignment);
    const cap = packingCap(struct);
    if (!isPacked && cap !== undefined) unionAlignment = Math.min(unionAlignment, cap);
    unionAlignment = Math.max(unionAlignment, maxExplicitAlignment);
    if (struct.alignAttribute !== undefined) {
      unionAlignment = Math.max(unionAlignment, this.resolveAlignRequest(struct.alignAttribute));
    }

    const trailingPadding = this.calculatePadding(maxSize, unionAlignment);
    const totalSize = maxSize + trailingPadding;

    return {
      struct: {
        ...struct,
        totalSize,
        alignment: unionAlignment,
        totalPadding: trailingPadding,
      },
      members,
      totalSize,
      totalPadding: trailingPadding,
      wastedSpace: trailingPadding,
      efficiency: maxSize > 0 ? (maxSize / totalSize) * 100 : 0,
      architecture: this.architecture.name,
    };
  }

  /** Size and natural alignment of a bit-field's declared type, which may be an enum. */
  private bitfieldTypeInfo(member: StructMember): { size: number; alignment: number } {
    return member.enumType ? this.getEnumTypeInfo(member.enumType) : this.getTypeInfo(member.type);
  }

  /** Size and effective alignment of a member inside `struct`, plus a nested record's own layout. */
  private memberLayout(member: StructMember, struct: ParsedStruct, isPacked: boolean): MemberInfo {
    const info = this.getMemberSizeAndAlignment(member, isPacked);
    return { ...info, alignment: this.effectiveAlignment(member, info.alignment, struct, isPacked) };
  }

  /**
   * A member's alignment after packing and alignment requests:
   * packed (mode or attribute) makes it 1, `#pragma pack(n)` caps it at n, and an explicit
   * aligned/alignas raises it again -- an explicit request is never lowered by packing.
   */
  private effectiveAlignment(member: StructMember, natural: number, struct: ParsedStruct, isPacked: boolean): number {
    let alignment = natural;
    const cap = packingCap(struct);
    if (isPacked || member.packed) alignment = 1;
    else if (cap !== undefined) alignment = Math.min(alignment, cap);
    if (member.alignAttribute !== undefined) {
      alignment = Math.max(alignment, this.resolveAlignRequest(member.alignAttribute));
    }
    return Math.max(1, alignment);
  }

  private structAlignment(struct: ParsedStruct, maxMemberAlignment: number, maxExplicit: number, isPacked: boolean): number {
    let alignment = isPacked ? 1 : this.getStructAlignment(maxMemberAlignment);
    const cap = packingCap(struct);
    if (!isPacked && cap !== undefined) alignment = Math.min(alignment, cap);
    alignment = Math.max(alignment, maxExplicit);
    if (struct.alignAttribute !== undefined) {
      alignment = Math.max(alignment, this.resolveAlignRequest(struct.alignAttribute));
    }
    return alignment;
  }

  private resolveAlignRequest(request: AlignRequest): number {
    if (typeof request === 'number') return request;
    if (request === 'max') return this.architecture.maxAlignment ?? this.architecture.defaultAlignment;
    return this.getTypeInfo(request.ofType).alignment;
  }

  /**
   * Size and natural alignment, before packing and alignment requests. For a nested struct or
   * union (or an array of one), also the layout of one element.
   */
  private getMemberSizeAndAlignment(member: StructMember, isPacked: boolean): MemberInfo {
    // Arrays, including the flexible array member (arraySize 0: no size, element alignment).
    if (member.arraySize !== undefined) {
      if (member.enumType) {
        const enumInfo = this.getEnumTypeInfo(member.enumType);
        return { size: enumInfo.size * member.arraySize, alignment: enumInfo.alignment };
      }
      if (member.isNested && member.nestedStruct) {
        const nestedResult = this.calculate(member.nestedStruct, { packed: isPacked });
        return {
          size: nestedResult.totalSize * member.arraySize,
          alignment: nestedResult.struct.alignment || this.architecture.defaultAlignment,
          nested: nestedResult,
        };
      }

      const elementInfo = this.scalarTypeInfo(member);
      return { size: elementInfo.size * member.arraySize, alignment: elementInfo.alignment };
    }

    if (member.bitField !== undefined) {
      const typeInfo = this.bitfieldTypeInfo(member);
      return { size: Math.ceil(member.bitField / 8), alignment: typeInfo.alignment };
    }

    if (member.enumType) {
      return this.getEnumTypeInfo(member.enumType);
    }

    if (member.isNested && member.nestedStruct) {
      const nestedResult = this.calculate(member.nestedStruct, { packed: isPacked });
      return {
        size: nestedResult.totalSize,
        alignment: nestedResult.struct.alignment || this.architecture.defaultAlignment,
        nested: nestedResult,
      };
    }

    return this.scalarTypeInfo(member);
  }

  /** A member of a scalar or pointer type; function pointers take the model's code-pointer size. */
  private scalarTypeInfo(member: StructMember): { size: number; alignment: number } {
    const functionPointerSize = dataModels[this.dataModel]?.dataTypes.functionPointerSize;
    if (member.functionPointer && functionPointerSize !== undefined) {
      const maxAlign = this.architecture.maxAlignment ?? this.architecture.defaultAlignment;
      return { size: functionPointerSize, alignment: Math.min(functionPointerSize, maxAlign) };
    }
    return this.getTypeInfo(member.type);
  }

  private getStandardTypeInfo(normalizedType: string): { size: number; alignment: number } | null {
    const typeMap = getStandardTypeMap(this.dataModel);
    return typeMap[normalizedType] || null;
  }

  private getTypeInfo(type: string): { size: number; alignment: number } {
    // Pointers: aligned to their size, capped like every other type (1 on AVR and the 8051).
    if (type.includes('*')) {
      const maxAlign = this.architecture.maxAlignment ?? this.architecture.defaultAlignment;
      return {
        size: this.architecture.pointerSize,
        alignment: Math.min(this.architecture.pointerSize, maxAlign),
      };
    }

    // Normalize type (remove const, volatile, etc.)
    const normalizedType = this.normalizeType(type);

    // First try to get from standard type mapping based on data model
    let typeInfo = this.getStandardTypeInfo(normalizedType);

    // Architecture data types override model defaults (ABI-specific overrides).
    if (this.architecture.dataTypes) {
      const dataType = this.architecture.dataTypes[normalizedType];
      if (dataType) {
        typeInfo = {
          size: dataType.size,
          alignment: dataType.alignment,
        };
      }
    }

    if (typeInfo) {
      // Cap alignment by architecture's maxAlignment
      const maxAlign = this.architecture.maxAlignment ?? this.architecture.defaultAlignment;
      const cappedAlignment = Math.min(typeInfo.alignment, maxAlign);
      return {
        size: typeInfo.size,
        alignment: cappedAlignment,
      };
    }

    // Default fallback (should ideally not reach here if parser is correct).
    // Recorded instead of logged so callers can surface it as a diagnostic.
    this.unknownTypes.add(normalizedType || type);
    return {
      size: 4,
      alignment: 4,
    };
  }

  private normalizeType(type: string): string {
    return type
      .replace(/\bconst\b/g, '')
      .replace(/\bvolatile\b/g, '')
      .replace(/\bstruct\b/g, '')
      .replace(/\bunion\b/g, '')
      .replace(/\benum\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * An enum's size and alignment. A written underlying type wins, then the user's override. A
   * packed enum, or any enum where the target uses short enums (arm-none-eabi, SDCC), is the
   * smallest of 1, 2, 4 or 8 bytes that holds its values. Otherwise it is int-sized, widened as GCC
   * does when a value does not fit an int: 70000 takes 4 bytes where int is 2 (AVR, SDCC). Checked
   * in tests/cross-compiler.test.ts.
   */
  private getEnumTypeInfo(enumType: ParsedEnum): { size: number; alignment: number } {
    if (enumType.underlyingType) {
      return this.getTypeInfo(enumType.underlyingType);
    }

    // Check for custom enum override in architecture first (user customization takes priority)
    if (this.architecture.dataTypes && this.architecture.dataTypes['enum']) {
      const enumTypeInfo = this.architecture.dataTypes['enum'];
      // Apply alignment capping to custom override as well
      const maxAlign = this.architecture.maxAlignment ?? this.architecture.defaultAlignment;
      const cappedAlignment = Math.min(enumTypeInfo.alignment, maxAlign);
      return { size: enumTypeInfo.size, alignment: cappedAlignment };
    }

    const needed = bytesForValues(enumType.members.map((m) => m.value ?? 0));
    const intSize = dataModels[this.dataModel].dataTypes.enumSize;
    const short = enumType.packed === true || this.architecture.shortEnums === true;
    return this.integerOfSize(short ? needed : Math.max(intSize, needed));
  }

  /** The target's integer type of `size` bytes, for its alignment. */
  private integerOfSize(size: number): { size: number; alignment: number } {
    for (const type of ['char', 'short', 'int', 'long', 'long long']) {
      const info = this.getTypeInfo(type);
      if (info.size === size) return info;
    }
    const maxAlign = this.architecture.maxAlignment ?? this.architecture.defaultAlignment;
    return { size, alignment: Math.min(size, maxAlign) };
  }

  private calculatePadding(currentOffset: number, alignment: number): number {
    const remainder = currentOffset % alignment;
    return remainder === 0 ? 0 : alignment - remainder;
  }

  private getStructAlignment(maxMemberAlignment: number): number {
    const { packingRules, maxAlignment } = this.architecture;

    if (typeof packingRules.structAlignment === 'number') {
      return packingRules.structAlignment;
    }

    if (packingRules.structAlignment === 'default') {
      return this.architecture.defaultAlignment;
    }

    // 'max' alignment - use the maximum member alignment
    let alignment = maxMemberAlignment;

    // Cap at max alignment if specified
    if (maxAlignment !== undefined) {
      alignment = Math.min(alignment, maxAlignment);
    }

    return alignment;
  }

  /**
   * Reorder members for minimal padding: by alignment, then size, both descending.
   *
   * A run of consecutive bit-fields moves as one unit, because splitting it would change which
   * fields share a storage unit (and so what the struct means). A flexible array member stays
   * last, where C requires it.
   */
  suggestOptimization(struct: ParsedStruct): ParsedStruct {
    const isUnion = struct.isUnion === true;

    const optimizedMembers = struct.members.map((member) => {
      if (member.isNested && member.nestedStruct) {
        return { ...member, nestedStruct: this.suggestOptimization(member.nestedStruct) };
      }
      return member;
    });

    if (isUnion) {
      // Reordering union members does not change layout; keep original order
      return { ...struct, members: optimizedMembers };
    }

    const isFlexible = (m: StructMember) => m.arraySize === 0 && m.arrayDims?.[0] === 0;
    const tail = optimizedMembers.filter(isFlexible);
    const units: Array<{ members: StructMember[]; size: number; alignment: number }> = [];
    for (const member of optimizedMembers) {
      if (isFlexible(member)) continue;
      const { size, alignment } = this.memberLayout(member, struct, false);
      const last = units[units.length - 1];
      if (member.bitField !== undefined && last && last.members[last.members.length - 1].bitField !== undefined) {
        last.members.push(member);
        last.size += size;
        continue;
      }
      units.push({ members: [member], size, alignment });
    }

    units.sort((a, b) => (b.alignment !== a.alignment ? b.alignment - a.alignment : b.size - a.size));

    return { ...struct, members: [...units.flatMap((u) => u.members), ...tail] };
  }

  // Compare current vs optimized layout
  compareLayouts(struct: ParsedStruct): {
    current: CalculationResult;
    optimized: CalculationResult;
    savings: number;
    savingsPercent: number;
  } {
    const current = this.calculate(struct);
    const optimizedStruct = this.suggestOptimization(struct);
    const optimized = this.calculate(optimizedStruct);

    const savings = current.totalSize - optimized.totalSize;
    const savingsPercent = current.totalSize > 0 ? (savings / current.totalSize) * 100 : 0;

    return {
      current,
      optimized,
      savings,
      savingsPercent,
    };
  }
}
