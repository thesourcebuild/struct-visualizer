// Core types for struct padding calculator

export interface DataType {
  name: string;
  size: number;
  alignment: number;
  category: 'primitive' | 'pointer' | 'struct' | 'union' | 'array';
}

/**
 * An explicit alignment request: a byte count, 'max' for `aligned` with no argument (the
 * target's largest alignment), or the alignment of a type for `alignas(type)`.
 */
export type AlignRequest = number | 'max' | { ofType: string };

export interface StructMember {
  /** Empty for unnamed members: unnamed bit-fields and C11 anonymous struct/union members. */
  name: string;
  /** Layout type after typedef resolution, e.g. 'unsigned int', 'char*', 'struct Point'. */
  type: string;
  /** The type as written, when it differs from `type` (a typedef name, a function pointer). */
  declaredType?: string;
  /** Total element count (product of all dimensions); 0 for a flexible array member. */
  arraySize?: number;
  /** Each dimension as written, e.g. [3, 4] for `m[3][4]`. */
  arrayDims?: number[];
  bitField?: number;
  offset?: number;
  paddingAfter?: number;
  isNested?: boolean;
  nestedStruct?: ParsedStruct;
  enumType?: ParsedEnum;
  /** `__attribute__((aligned(n)))`, `alignas(n)`, `_Alignas(n)` or `__declspec(align(n))` on the member. */
  alignAttribute?: AlignRequest;
  /** `__attribute__((packed))` on the member: alignment 1. */
  packed?: boolean;
  /**
   * A pointer to a function (or an array of them). It holds a code address, which some targets
   * size apart from data pointers: 2 bytes on SDCC's 8051 against 3 for a generic data pointer.
   */
  functionPointer?: boolean;
  /** 1-based source line of the declaration. */
  line?: number;
}

export interface ParsedStruct {
  name: string;
  members: StructMember[];
  isUnion?: boolean;
  /** An enum shown as its variants overlapping (isUnion is also set). */
  isEnum?: boolean;
  totalSize?: number;
  alignment?: number;
  totalPadding?: number;
  /** `#pragma pack(n)` in effect at the definition: n caps every member's alignment. */
  pragmaPack?: number;
  /** `__attribute__((packed))` on the type: every member at alignment 1. */
  packed?: boolean;
  /** Minimum struct alignment from `__attribute__((aligned(n)))` / `alignas` on the type. */
  alignAttribute?: AlignRequest;
  /** 1-based source line where the definition starts. */
  line?: number;
  /**
   * The name comes from a typedef of an anonymous struct (`typedef struct { ... } Name;`), so C
   * code must write `Name`, not `struct Name`.
   */
  nameIsTypedef?: boolean;
}

export interface EnumMember {
  name: string;
  value?: number;
  valueRaw?: string;
}

export interface ParsedEnum {
  name: string;
  members: EnumMember[];
  /** Written as `enum E : type` (C23, C++11). */
  underlyingType?: string;
  /** `__attribute__((packed))`: the smallest integer type that holds every value. */
  packed?: boolean;
}

export interface Architecture {
  id: string;
  name: string;
  displayName: string;
  description: string;
  dataTypes?: Record<string, DataType>;
  pointerSize?: number;
  defaultAlignment?: number;
  maxAlignment?: number;
  packingRules?: PackingRules;
  /**
   * How the target's compiler allocates bit-fields: 'gcc' bit by bit (GCC and Clang outside
   * Windows), 'ms' in storage units of each field's type (MSVC, and MinGW by default), 'sdcc'
   * bit by bit but never splitting a field that would fit in a byte. See
   * PaddingCalculator.calculateStruct.
   */
  bitfieldLayout?: 'gcc' | 'ms' | 'sdcc';
  /**
   * Under 'gcc': a bit-field's declared type limits where it may go and sets the struct's
   * alignment (GCC's PCC_BITFIELD_TYPE_MATTERS). False on AVR, where fields are packed bit by bit.
   */
  bitfieldTypeMatters?: boolean;
  /** Under 'gcc': unnamed bit-fields also raise the struct's alignment (GCC's align_anon_bitfield; ARM). */
  alignUnnamedBitfields?: boolean;
  /** Enums take the smallest integer type that holds their values (-fshort-enums; arm-none-eabi). */
  shortEnums?: boolean;
}

export interface PackingRules {
  structAlignment: 'max' | 'default' | number;
  paddingAlignment: boolean;
  bitfieldRules?: {
    crossBoundary: boolean;
    unnamedPadding: boolean;
  };
}

export interface Compiler {
  id: string;
  name: string;
  architectures: string[];
  packingBehavior?: {
    pragma?: boolean;
    attribute?: boolean;
  };
}

export interface CalculationResult {
  struct: ParsedStruct;
  members: Array<{
    member: StructMember;
    /** First byte the member occupies; for a bit-field, the byte holding its first bit. */
    offset: number;
    /** Bytes the member occupies; for a bit-field, the bytes its bits touch. */
    size: number;
    /**
     * A bit-field's first bit, counted from the start of the record. Bits are numbered from the
     * least significant bit of each byte, as the compilers modelled here allocate them.
     */
    bitOffset?: number;
    padding: number;
    alignment: number;
    /** Layout of a nested struct/union/enum member, computed by the same language engine. */
    nested?: CalculationResult;
  }>;
  totalSize: number;
  totalPadding: number;
  wastedSpace: number;
  efficiency: number;
  architecture: string;
}

export interface ParseError {
  line?: number;
  column?: number;
  message: string;
  type: 'syntax' | 'semantic' | 'warning';
}

export interface ValidationResult {
  isValid: boolean;
  errors: ParseError[];
  warnings: ParseError[];
}
