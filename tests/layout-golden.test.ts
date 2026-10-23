import assert from 'node:assert/strict';
import { it } from 'vitest';
import {
  applyPacking,
  CCodeGenerator,
  PaddingCalculator,
  StructParser,
  architectures,
  dataModels,
  examples,
  getArchitectureId,
  getStandardTypeMap,
  getSupportedOSTypes,
  getValidDataModelsForArchitecture,
  resolveArchitectureForSelection,
  targetArchitectureList,
} from '@sp/core';
import type {
  CalculationResult,
  DataModel,
  OSType,
  ParsedEnum,
  ParsedStruct,
  ParserTarget,
  ResolvedArchitecture,
  StructMember,
  TargetArchitecture,
} from '@sp/core';

type TestCase = {
  name: string;
  code: string;
  run: (result: CalculationResult, packed: CalculationResult) => void;
};

const PRINT_LAYOUTS = process.env.PRINT_LAYOUTS === '1' || process.argv.includes('--print-layouts');

type ExpectedLayout = {
  totalSize: number;
  totalPadding: number;
  alignment: number;
  members: Array<{
    offset: number;
    size: number;
    padding: number;
    alignment: number;
    name: string;
  }>;
};

function formatErrors(messages: Array<{ message: string }>): string {
  return messages.map((e) => e.message).join(' | ');
}

function normalizeType(type: string): string {
  return type
    .replace(/\bconst\b/g, '')
    .replace(/\bvolatile\b/g, '')
    .replace(/\bstruct\b/g, '')
    .replace(/\bunion\b/g, '')
    .replace(/\benum\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function calculatePadding(offset: number, alignment: number): number {
  if (alignment <= 0) return 0;
  const remainder = offset % alignment;
  return remainder === 0 ? 0 : alignment - remainder;
}

function getStructAlignment(maxMemberAlignment: number, architecture: ResolvedArchitecture): number {
  const { packingRules, maxAlignment } = architecture;

  if (typeof packingRules.structAlignment === 'number') {
    return packingRules.structAlignment;
  }

  if (packingRules.structAlignment === 'default') {
    return architecture.defaultAlignment;
  }

  let alignment = maxMemberAlignment;
  if (maxAlignment !== undefined) {
    alignment = Math.min(alignment, maxAlignment);
  }
  return alignment;
}

function getTypeInfoForExpected(
  type: string,
  architecture: ResolvedArchitecture,
  dataModel: DataModel
): { size: number; alignment: number } {
  if (type.includes('*')) {
    // Capped like any type: avr-gcc and SDCC align their 2- and 3-byte pointers to 1.
    return {
      size: architecture.pointerSize,
      alignment: Math.min(architecture.pointerSize, architecture.maxAlignment ?? architecture.defaultAlignment),
    };
  }

  const normalizedType = normalizeType(type);
  const standardMap = getStandardTypeMap(dataModel);
  let typeInfo = standardMap[normalizedType] || null;

  if (architecture.dataTypes) {
    const dataType = architecture.dataTypes[normalizedType];
    if (dataType) {
      typeInfo = {
        size: dataType.size,
        alignment: dataType.alignment,
      };
    }
  }

  if (!typeInfo) {
    return { size: 4, alignment: 4 };
  }

  const maxAlign = architecture.maxAlignment ?? architecture.defaultAlignment;
  return {
    size: typeInfo.size,
    alignment: Math.min(typeInfo.alignment, maxAlign),
  };
}

function getEnumInfoForExpected(
  enumType: ParsedEnum,
  architecture: ResolvedArchitecture,
  dataModel: DataModel
): { size: number; alignment: number } {
  if (enumType.underlyingType) {
    return getTypeInfoForExpected(enumType.underlyingType, architecture, dataModel);
  }

  if (architecture.dataTypes && architecture.dataTypes.enum) {
    const override = architecture.dataTypes.enum;
    const maxAlign = architecture.maxAlignment ?? architecture.defaultAlignment;
    return {
      size: override.size,
      alignment: Math.min(override.alignment, maxAlign),
    };
  }

  // The smallest of 1, 2, 4 or 8 bytes that holds every value; packed and short enums use it, other
  // enums are int-sized unless a value needs more.
  const values = enumType.members.map((m) => m.value ?? 0);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const fits = (bytes: number) =>
    lo >= 0 ? hi < 2 ** (8 * bytes) : lo >= -(2 ** (8 * bytes - 1)) && hi < 2 ** (8 * bytes - 1);
  const needed = [1, 2, 4].find(fits) ?? 8;
  const intSize = dataModels[dataModel].dataTypes.enumSize;
  const size = enumType.packed || architecture.shortEnums ? needed : Math.max(intSize, needed);
  const maxAlign = architecture.maxAlignment ?? architecture.defaultAlignment;
  return { size, alignment: Math.min(size, maxAlign) };
}

/** A scalar or pointer member; function pointers take the model's code-pointer size if it has one. */
function getScalarInfoForExpected(
  member: StructMember,
  architecture: ResolvedArchitecture,
  dataModel: DataModel
): { size: number; alignment: number } {
  const functionPointerSize = dataModels[dataModel].dataTypes.functionPointerSize;
  if (member.functionPointer && functionPointerSize !== undefined) {
    const maxAlign = architecture.maxAlignment ?? architecture.defaultAlignment;
    return { size: functionPointerSize, alignment: Math.min(functionPointerSize, maxAlign) };
  }
  return getTypeInfoForExpected(member.type, architecture, dataModel);
}

function getMemberSizeAndAlignmentForExpected(
  member: StructMember,
  architecture: ResolvedArchitecture,
  dataModel: DataModel,
  isPacked: boolean
): { size: number; alignment: number } {
  if (member.arraySize) {
    if (member.enumType) {
      const enumInfo = getEnumInfoForExpected(member.enumType, architecture, dataModel);
      return {
        size: enumInfo.size * member.arraySize,
        alignment: isPacked ? 1 : enumInfo.alignment,
      };
    }

    if (member.isNested && member.nestedStruct) {
      const nested = calculateExpectedLayout(member.nestedStruct, architecture, dataModel, isPacked);
      return {
        size: nested.totalSize * member.arraySize,
        alignment: isPacked ? 1 : nested.alignment,
      };
    }

    const elem = getScalarInfoForExpected(member, architecture, dataModel);
    return {
      size: elem.size * member.arraySize,
      alignment: isPacked ? 1 : elem.alignment,
    };
  }

  if (member.bitField !== undefined) {
    const info = getTypeInfoForExpected(member.type, architecture, dataModel);
    return {
      size: Math.ceil(member.bitField / 8),
      alignment: isPacked ? 1 : info.alignment,
    };
  }

  if (member.enumType) {
    const enumInfo = getEnumInfoForExpected(member.enumType, architecture, dataModel);
    return {
      size: enumInfo.size,
      alignment: isPacked ? 1 : enumInfo.alignment,
    };
  }

  if (member.isNested && member.nestedStruct) {
    const nested = calculateExpectedLayout(member.nestedStruct, architecture, dataModel, isPacked);
    return {
      size: nested.totalSize,
      alignment: isPacked ? 1 : nested.alignment,
    };
  }

  const typeInfo = getScalarInfoForExpected(member, architecture, dataModel);
  return {
    size: typeInfo.size,
    alignment: isPacked ? 1 : typeInfo.alignment,
  };
}

function calculateExpectedLayout(
  parsed: ParsedStruct,
  architecture: ResolvedArchitecture,
  dataModel: DataModel,
  isPacked: boolean
): ExpectedLayout {
  if (parsed.isUnion) {
    let maxSize = 0;
    let maxAlignment = 1;
    const members = parsed.members.map((member) => {
      const { size, alignment } = getMemberSizeAndAlignmentForExpected(member, architecture, dataModel, isPacked);
      maxSize = Math.max(maxSize, size);
      maxAlignment = Math.max(maxAlignment, alignment);
      return {
        offset: 0,
        size,
        padding: 0,
        alignment,
        name: member.name,
      };
    });

    const alignment = isPacked ? 1 : Math.min(maxAlignment, architecture.maxAlignment ?? maxAlignment);
    const trailingPadding = isPacked ? 0 : calculatePadding(maxSize, alignment);

    return {
      totalSize: maxSize + trailingPadding,
      totalPadding: trailingPadding,
      alignment,
      members,
    };
  }

  let currentOffset = 0;
  let maxAlignment = 1;
  const members: ExpectedLayout['members'] = [];

  for (const member of parsed.members) {
    if (member.bitField !== undefined) {
      throw new Error('the reference layout does not model bit-fields; tests/cross-compiler.test.ts checks them');
    }

    const { size, alignment } = getMemberSizeAndAlignmentForExpected(member, architecture, dataModel, isPacked);
    maxAlignment = Math.max(maxAlignment, alignment);

    const padding = isPacked ? 0 : calculatePadding(currentOffset, alignment);
    currentOffset += padding;

    members.push({
      offset: currentOffset,
      size,
      padding,
      alignment,
      name: member.name,
    });

    currentOffset += size;
  }

  const alignment = isPacked ? 1 : getStructAlignment(maxAlignment, architecture);
  const trailingPadding = isPacked ? 0 : calculatePadding(currentOffset, alignment);
  const totalSize = currentOffset + trailingPadding;
  const totalPadding = members.reduce((sum, m) => sum + m.padding, 0) + trailingPadding;

  return {
    totalSize,
    totalPadding,
    alignment,
    members,
  };
}

function assertEqualsExpected(actual: CalculationResult, expected: ExpectedLayout, label: string): void {
  assert.equal(actual.totalSize, expected.totalSize, `${label}: totalSize mismatch`);
  assert.equal(actual.totalPadding, expected.totalPadding, `${label}: totalPadding mismatch`);
  assert.equal(actual.struct.alignment, expected.alignment, `${label}: alignment mismatch`);
  assert.equal(actual.members.length, expected.members.length, `${label}: member count mismatch`);

  for (let i = 0; i < expected.members.length; i += 1) {
    const a = actual.members[i];
    const e = expected.members[i];
    assert.equal(a.member.name, e.name, `${label}: member[${i}] name mismatch`);
    assert.equal(a.offset, e.offset, `${label}: member '${e.name}' offset mismatch`);
    assert.equal(a.size, e.size, `${label}: member '${e.name}' size mismatch`);
    assert.equal(a.padding, e.padding, `${label}: member '${e.name}' padding mismatch`);
    assert.equal(a.alignment, e.alignment, `${label}: member '${e.name}' alignment mismatch`);
  }
}

function assertBasicLayoutInvariants(result: CalculationResult, isPacked: boolean): void {
  assert.ok(result.totalSize >= 0, 'total size must be non-negative');
  assert.ok(result.totalPadding >= 0, 'total padding must be non-negative');
  assert.ok(result.efficiency >= 0 && result.efficiency <= 100, 'efficiency must be in [0, 100]');

  if (result.struct.isUnion) {
    for (const member of result.members) {
      assert.equal(member.offset, 0, `union member '${member.member.name}' must start at offset 0`);
      assert.ok(member.size >= 0, 'union member size must be non-negative');
    }
    const maxMemberSize = result.members.reduce((max, m) => Math.max(max, m.size), 0);
    assert.ok(result.totalSize >= maxMemberSize, 'union total size must fit largest member');
  } else {
    let previousOffset = -1;
    for (const member of result.members) {
      assert.ok(member.offset >= previousOffset, `member '${member.member.name}' offset must be non-decreasing`);
      previousOffset = member.offset;

      assert.ok(member.padding >= 0, `member '${member.member.name}' padding must be non-negative`);
      assert.ok(member.size >= 0, `member '${member.member.name}' size must be non-negative`);
      if (!isPacked) {
        assert.ok(member.alignment >= 1, `member '${member.member.name}' alignment must be >= 1`);
      }
      const bits = member.member.bitField;
      if (bits !== undefined) {
        // A bit-field is placed by bit, not by its type's alignment: its byte range is the
        // bytes its bits touch.
        assert.ok(member.bitOffset !== undefined, `bit-field '${member.member.name}' must have a bit offset`);
        assert.equal(member.offset, Math.floor(member.bitOffset / 8), `bit-field '${member.member.name}' offset must hold its first bit`);
        const span = bits === 0 ? 0 : Math.floor((member.bitOffset + bits - 1) / 8) - member.offset + 1;
        assert.equal(member.size, span, `bit-field '${member.member.name}' size must cover its bits`);
      } else if (!isPacked && member.alignment > 0) {
        assert.equal(
          member.offset % member.alignment,
          0,
          `member '${member.member.name}' offset must satisfy alignment`
        );
      }
    }

    const end = result.members.reduce((max, m) => Math.max(max, m.offset + m.size), 0);
    assert.ok(result.totalSize >= end, 'struct total size must cover all members');
  }

  const structAlignment = result.struct.alignment ?? 1;
  assert.ok(structAlignment >= 1, 'struct alignment must be >= 1');
  assert.equal(result.totalSize % structAlignment, 0, 'total size must be aligned to struct alignment');
}

function assertVerificationGeneration(code: string, parsed: ParsedStruct, target: ParserTarget): void {
  const cCode = CCodeGenerator.generateVerificationCode(code, target, parsed.name, 'c');
  const cppCode = CCodeGenerator.generateVerificationCode(code, target, parsed.name, 'cpp');

  assert.ok(cCode.includes('#include <stdio.h>'), 'C verification code must include stdio');
  assert.ok(cCode.includes('offsetof('), 'C verification code must print offsetof');
  assert.ok(cppCode.includes('#include <iostream>'), 'C++ verification code must include iostream');
  assert.ok(cppCode.includes('#include <iomanip>'), 'C++ verification code must include iomanip');
  assert.ok(cppCode.includes('offsetof('), 'C++ verification code must print offsetof');
}

/** Whether the struct or any struct nested in it has a bit-field. */
function hasBitfields(parsed: ParsedStruct): boolean {
  return parsed.members.some((m) => m.bitField !== undefined || (m.nestedStruct !== undefined && hasBitfields(m.nestedStruct)));
}

function runSingleCode(
  code: string,
  target: TargetArchitecture,
  osType: OSType,
  dataModel: DataModel,
  caseLabel: string
): { result: CalculationResult; packed: CalculationResult; parsed: ParsedStruct } {
  const architectureId = getArchitectureId(dataModel, target, osType);
  const baseArchitecture = architectures[architectureId];
  const architecture = baseArchitecture
    ? resolveArchitectureForSelection(baseArchitecture, dataModel, target, osType)
    : undefined;

  assert.ok(
    architecture,
    `missing architecture mapping for combo: ${dataModel}/${target}/${osType} -> ${architectureId}`
  );

  const parser = new StructParser({ architecture, dataModel });
  const validation = parser.parse(code);
  assert.ok(
    validation.isValid,
    `parse failed for ${dataModel}/${target}/${osType}: ${formatErrors(validation.errors)}`
  );

  const parsed = parser.getLastDefinition();
  assert.ok(parsed, `no parsed definition found for ${dataModel}/${target}/${osType}`);

  const calculator = new PaddingCalculator(architecture, dataModel);
  const result = calculator.calculate(parsed);
  // Packed: the source with __attribute__((packed)) on every definition, laid out the same way.
  const packedParser = new StructParser({ architecture, dataModel });
  packedParser.parse(applyPacking(code, 'attribute'));
  const packed = calculator.calculate(packedParser.getLastDefinition()!);
  const comparison = calculator.compareLayouts(parsed);

  // Bit-field placement is checked against the real compilers in tests/cross-compiler.test.ts;
  // the reference here covers everything else.
  if (!hasBitfields(parsed)) {
    const expected = calculateExpectedLayout(parsed, architecture, dataModel, false);
    const expectedPacked = calculateExpectedLayout(parsed, architecture, dataModel, true);

    assertEqualsExpected(result, expected, `${caseLabel} [normal]`);
    assertEqualsExpected(packed, expectedPacked, `${caseLabel} [packed]`);
    if (PRINT_LAYOUTS) {
      console.log(
        `[golden] ${caseLabel} [normal] | actual: size=${result.totalSize}, padding=${result.totalPadding}, align=${result.struct.alignment} | golden: size=${expected.totalSize}, padding=${expected.totalPadding}, align=${expected.alignment}`
      );
      console.log(
        `[golden] ${caseLabel} [packed] | actual: size=${packed.totalSize}, padding=${packed.totalPadding}, align=${packed.struct.alignment} | golden: size=${expectedPacked.totalSize}, padding=${expectedPacked.totalPadding}, align=${expectedPacked.alignment}`
      );
    }
  }


  assert.ok(comparison.optimized.totalSize <= comparison.current.totalSize, 'optimized layout must not be larger');

  assertBasicLayoutInvariants(result, false);
  assertBasicLayoutInvariants(packed, true);
  assertVerificationGeneration(code, parsed, { architecture, dataModel });

  return { result, packed, parsed };
}

const customCases: TestCase[] = [
  {
    name: 'Bitfield Packing Basics',
    code: `
struct BitfieldPack {
  unsigned int a:3;
  unsigned int b:5;
  unsigned int c:9;
  char tail;
};
`,
    run: (result) => {
      assert.ok(result.members.length >= 4, 'expected 4 members in bitfield struct');
      const a = result.members.find((m) => m.member.name === 'a');
      const b = result.members.find((m) => m.member.name === 'b');
      const c = result.members.find((m) => m.member.name === 'c');
      const tail = result.members.find((m) => m.member.name === 'tail');
      assert.ok(a && b && c && tail, 'bitfield members should exist');
      assert.equal(a.offset, b.offset, 'adjacent bitfields should share same storage unit when they fit');
      assert.ok(c.offset >= b.offset, 'overflowing bitfield should not move backward');
      assert.ok(tail.offset >= c.offset, 'non-bitfield after bitfields should not move backward');
    },
  },
  {
    name: 'Nested + Typedef Enum + Union',
    code: `
typedef enum Status {
  STATUS_IDLE = 0,
  STATUS_BUSY = 1
} Status_t;

struct Header {
  uint16_t len;
  uint8_t kind;
};

union Payload {
  uint32_t ivalue;
  float fvalue;
  char text[8];
};

struct Packet {
  struct Header h;
  Status_t status;
  union Payload payload;
  uint8_t checksum;
};
`,
    run: (result, packed) => {
      assert.ok(result.totalSize >= packed.totalSize, 'packed layout should be <= unpacked layout');
      assert.ok(result.members.some((m) => m.member.name === 'payload'), 'payload member must be present');
    },
  },
  {
    name: 'Anonymous Nested Types',
    code: `
struct Complex {
  struct {
    uint8_t a;
    uint32_t b;
  } inner;

  union {
    uint64_t wide;
    uint16_t parts[4];
  } data;

  char tail;
};
`,
    run: (result) => {
      assert.ok(result.members.some((m) => m.member.isNested), 'expected nested members in anonymous types');
    },
  },
];

const canonicalExampleExpectations: Record<string, { totalSize: number; totalPadding: number; alignment: number }> = {
  'Basic Struct': { totalSize: 24, totalPadding: 10, alignment: 8 },
  'Optimized Struct': { totalSize: 16, totalPadding: 2, alignment: 8 },
  'Nested Struct': { totalSize: 16, totalPadding: 6, alignment: 4 },
  'Array Members': { totalSize: 56, totalPadding: 3, alignment: 4 },
  'Pointer Members': { totalSize: 40, totalPadding: 20, alignment: 8 },
  'Advanced Pointers (Double + Function)': { totalSize: 32, totalPadding: 7, alignment: 8 },
  'Enum Members': { totalSize: 16, totalPadding: 3, alignment: 4 },
  'Typedef Enum Members': { totalSize: 16, totalPadding: 0, alignment: 4 },
  'Bitfield Complex': { totalSize: 12, totalPadding: 3, alignment: 4 },
  'Basic Union': { totalSize: 4, totalPadding: 0, alignment: 4 },
  'Complex Union': { totalSize: 16, totalPadding: 0, alignment: 8 },
  'Struct with Nested Struct & Union': { totalSize: 24, totalPadding: 7, alignment: 8 },
  'Advanced Mixed (Struct/Union/Arrays)': { totalSize: 40, totalPadding: 0, alignment: 8 },
  'Ultra-Complex Nested (Inline Struct/Union)': { totalSize: 368, totalPadding: 14, alignment: 8 },
};

function runMatrixCoverage(): number {
  let executed = 0;

  for (const targetInfo of targetArchitectureList) {
    const target = targetInfo.id;
    const models = getValidDataModelsForArchitecture(target);
    const osTypes = getSupportedOSTypes(target);

    assert.ok(models.length > 0, `no data models available for target '${target}'`);
    assert.ok(osTypes.length > 0, `no OS types available for target '${target}'`);

    for (const dataModel of models) {
      for (const osType of osTypes) {
        for (const example of examples) {
          for (const lang of ['c', 'cpp'] as const) {
            const code = example.code[lang];
            const caseLabel = `${example.name}/${lang}/${target}/${osType}/${dataModel}`;
            const { result } = runSingleCode(code, target, osType, dataModel, caseLabel);

            if (target === 'intel-x64-amd' && osType === 'linux' && dataModel === 'LP64') {
              const expected = canonicalExampleExpectations[example.name];
              assert.ok(expected, `${caseLabel}: missing canonical expectation for example`);
              assert.equal(result.totalSize, expected.totalSize, `${caseLabel}: expected totalSize ${expected.totalSize}`);
              assert.equal(result.totalPadding, expected.totalPadding, `${caseLabel}: expected totalPadding ${expected.totalPadding}`);
              assert.equal(result.struct.alignment, expected.alignment, `${caseLabel}: expected alignment ${expected.alignment}`);
            }

            executed += 1;
          }
        }

        for (const custom of customCases) {
          const caseLabel = `${custom.name}/${target}/${osType}/${dataModel}`;
          const { result, packed } = runSingleCode(custom.code, target, osType, dataModel, caseLabel);
          custom.run(result, packed);
          executed += 1;
        }
      }
    }
  }

  assert.ok(executed > 0, 'expected at least one test execution');
  return executed;
}

it("matches the independent reference layout and canonical sizes on every platform", () => {
  const executed = runMatrixCoverage();
  assert.equal(executed, 1240);
});
