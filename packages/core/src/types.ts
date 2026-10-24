// Core types for struct padding calculator

export interface DataType {
  name: string;
  size: number;
  alignment: number;
  category: 'primitive' | 'pointer' | 'struct' | 'union' | 'array';
}

/**
 * An explicit alignment request: a byte count, 'max' for `aligned` with no argument (the
 * target's largest alignment), or `alignas(type)`: the type as written and its alignment on the
 * target it was parsed for.
 */
export type AlignRequest = number | 'max' | { ofType: string; alignment: number };

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
   * The alignment of the member's type, set by an aligned typedef (`typedef int a8
   * __attribute__((aligned(8)));`). It replaces the type's natural alignment, smaller or larger,
   * and packing lowers it like any natural alignment, unlike `alignAttribute` on the member.
   */
  typeAlignment?: AlignRequest;
  /**
   * A pointer to a function (or an array of them). It holds a code address, which some targets
   * size apart from data pointers: 2 bytes on SDCC's 8051 against 3 for a generic data pointer.
   */
  functionPointer?: boolean;
  /** A C++ reference member: laid out as a pointer. */
  reference?: boolean;
  /** A C++ member that is not public. */
  access?: 'private' | 'protected';
  /**
   * The declaration as written, as tokens: its specifiers and its own declarator (with bit-field
   * width, attributes and initializer), so it can be written out again in another order.
   * `inlineType` when the specifiers define the member's record type in place.
   */
  source?: { spec: string[]; declarator: string[]; inlineType?: boolean };
  /**
   * C++ `[[no_unique_address]]` (honoured by the Itanium ABI) or `[[msvc::no_unique_address]]`
   * (honoured by MSVC): the member may share its address with other members.
   */
  noUniqueAddress?: 'std' | 'msvc';
  /**
   * Set on what a C++ layout adds besides the declared members: a base class subobject, the
   * pointer to the virtual function table (vptr, MSVC's vfptr), MSVC's pointer to the virtual
   * base table (vbptr), and MSVC's vtordisp before a virtual base.
   */
  role?: 'base' | 'virtual-base' | 'vptr' | 'vbptr' | 'vtordisp';
  /** 1-based source line of the declaration. */
  line?: number;
}

/** The C++ facts about a class that decide its layout, besides its members. */
export interface CppClass {
  key: 'struct' | 'class' | 'union';
  /** The standard it was parsed as: what counts as an aggregate differs (userDeclaredConstructor). */
  standard: 'c++17' | 'c++20';
  bases: CppBase[];
  /** The member functions it declares, to work out which are virtual and what they override. */
  methods: CppMethod[];
  /** `__declspec(empty_bases)` (MSVC): empty bases get the optimization the Itanium ABI gives them. */
  emptyBases?: boolean;
  /**
   * What makes a class not "POD for the purpose of layout" in the Itanium ABI, and so lets a
   * derived class reuse its tail padding. Measured with g++ (tests/cpp-compiler.test.ts).
   */
  userProvidedConstructor: boolean;
  /** Including `= default` and `= delete`: C++20 makes such a class a non-aggregate. */
  userDeclaredConstructor: boolean;
  explicitConstructor: boolean;
  userProvidedDestructor: boolean;
  userDeclaredDestructor: boolean;
  userProvidedCopyAssignment: boolean;
  nonPublicData: boolean;
  defaultMemberInitializer: boolean;
  referenceMember: boolean;
}

/**
 * The language the source is compiled as. C++17 stands for C++11 to C++17 and C++20 for C++20
 * and later: g++ lays out classes alike within each (tests/cpp-compiler.test.ts), and differently
 * across them for a class whose only constructors are defaulted or deleted.
 */
export type SourceLanguage = 'c' | 'c++17' | 'c++20';

export interface CppBase {
  def: ParsedStruct;
  virtual: boolean;
  /** As written, or the default: private for a class, public for a struct. */
  access: 'public' | 'protected' | 'private';
  line?: number;
}

export interface CppMethod {
  /** As declared: `f`, `~S`, `operator=`. */
  name: string;
  /** The parameter types and the method's own qualifiers, normalized: `(int,char*) const`. */
  signature: string;
  /** Declared `virtual`, `override` or `final`; one that overrides a base's is virtual too. */
  declaredVirtual: boolean;
  pure: boolean;
  destructor: boolean;
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
  /** Set for every class, struct and union parsed as C++. */
  cpp?: CppClass;
  /**
   * The definition as written, as tokens: everything before its body (keyword, attributes, tag,
   * base classes) and the attributes after it.
   */
  source?: { head: string[]; tail: string[] };
  /**
   * What the body declares besides data members, as written: member functions, constructors,
   * nested types, typedefs, static members, static assertions. With the access in effect (C++).
   */
  declarations?: Array<{ tokens: string[]; access?: 'public' | 'protected' | 'private' }>;
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
  /** The largest alignment a type gets on its own; alignment requests may exceed it. */
  maxAlignment?: number;
  /**
   * Byte order; little unless set. It does not move any member, but a bit-field's bits are
   * numbered from the most significant bit of each byte on a big-endian target.
   */
  endianness?: 'little' | 'big';
  /**
   * How the target's compiler allocates bit-fields: 'gcc' bit by bit (GCC and Clang outside
   * Windows), 'ms' in storage units of each field's type (MSVC), 'sdcc'
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
  /**
   * GCC's `__alignof__` for scalar types aligned more on their own than as members: on i386
   * SysV, 8-byte scalars are 8-aligned alone and 4-aligned in a struct, and `_Alignof` gives 4.
   * Measured in tests/cross-compiler.test.ts.
   */
  preferredAlignment?: Record<string, number>;
  /**
   * How C++ classes are laid out: the Itanium C++ ABI (GCC and Clang everywhere but Windows) or
   * MSVC's. Unset where the target's compiler has no C++ (SDCC, Keil C51, XC16).
   */
  cppAbi?: 'itanium' | 'msvc';
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
     * A bit-field's first bit, counted from the start of the record in memory order: bit 0 is the
     * least significant bit of byte 0 on a little-endian target, its most significant bit on a
     * big-endian one (CalculationResult.bigEndian), as the compilers allocate them.
     */
    bitOffset?: number;
    padding: number;
    alignment: number;
    /** Layout of a nested struct/union/enum member, computed by the same language engine. */
    nested?: CalculationResult;
    /**
     * Why it is where it is, when C's rule (the next offset its alignment allows) does not say:
     * C++ base subobjects, vptrs, tail padding reuse, the empty base optimization.
     */
    note?: string;
  }>;
  totalSize: number;
  totalPadding: number;
  wastedSpace: number;
  efficiency: number;
  architecture: string;
  /** A big-endian target: bit-field bits are numbered from each byte's most significant bit. */
  bigEndian?: boolean;
  /**
   * C++: the size of the class as a base subobject, without its virtual bases (nvsize). Under the
   * Itanium ABI it excludes the tail padding a derived class may reuse, unless the class is POD
   * for layout; under MSVC an empty class has 0.
   */
  baseSize?: number;
  /** C++: the alignment of the class as a base subobject, without its virtual bases. */
  baseAlignment?: number;
  /**
   * MSVC: the alignment requested in the record (alignas or __declspec(align) on it or any of its
   * members, at any depth), which #pragma pack does not lower wherever the record is used.
   */
  requiredAlignment?: number;
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
