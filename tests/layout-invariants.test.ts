import assert from 'node:assert/strict';
import { it } from 'vitest';
import {
  CCodeGenerator,
  PaddingCalculator,
  StructParser,
  architectures,
  examples,
  getArchitectureId,
  getSupportedOSTypes,
  getValidDataModelsForArchitecture,
  resolveArchitectureForSelection,
  targetArchitectureList,
} from '@sp/core';
import type { CalculationResult, DataModel, OSType, ParsedStruct, TargetArchitecture } from '@sp/core';

type TestCase = {
  name: string;
  code: string;
  run: (result: CalculationResult, packed: CalculationResult) => void;
};

const PRINT_LAYOUTS = process.env.PRINT_LAYOUTS === '1' || process.argv.includes('--print-layouts');

function formatErrors(messages: Array<{ message: string }>): string {
  return messages.map((e) => e.message).join(' | ');
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

function assertVerificationGeneration(code: string, parsed: ParsedStruct): void {
  const cCode = CCodeGenerator.generateVerificationCode(code, parsed.name, 'c');
  const cppCode = CCodeGenerator.generateVerificationCode(code, parsed.name, 'cpp');

  assert.ok(cCode.includes('#include <stdio.h>'), 'C verification code must include stdio');
  assert.ok(cCode.includes('offsetof('), 'C verification code must print offsetof');
  assert.ok(cppCode.includes('#include <iostream>'), 'C++ verification code must include iostream');
  assert.ok(cppCode.includes('#include <iomanip>'), 'C++ verification code must include iomanip');
  assert.ok(cppCode.includes('offsetof('), 'C++ verification code must print offsetof');
}

function runSingleCode(
  code: string,
  target: TargetArchitecture,
  osType: OSType,
  dataModel: DataModel,
  caseLabel?: string
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

  const parser = new StructParser();
  const validation = parser.parse(code);
  assert.ok(
    validation.isValid,
    `parse failed for ${dataModel}/${target}/${osType}: ${formatErrors(validation.errors)}`
  );

  const parsed = parser.getLastDefinition();
  assert.ok(parsed, `no parsed definition found for ${dataModel}/${target}/${osType}`);

  const calculator = new PaddingCalculator(architecture, dataModel);
  const result = calculator.calculate(parsed);
  const packed = calculator.calculate(parsed, { packed: true });
  const comparison = calculator.compareLayouts(parsed);

  assert.ok(comparison.optimized.totalSize <= comparison.current.totalSize, 'optimized layout must not be larger');

  assertBasicLayoutInvariants(result, false);
  assertBasicLayoutInvariants(packed, true);
  assertVerificationGeneration(code, parsed);

  if (PRINT_LAYOUTS) {
    const label = caseLabel ?? `${parsed.name}/${target}/${osType}/${dataModel}`;
    console.log(
      `[baseline] ${label} | actual(normal): size=${result.totalSize}, padding=${result.totalPadding}, align=${result.struct.alignment} | actual(packed): size=${packed.totalSize}, padding=${packed.totalPadding}, align=${packed.struct.alignment}`
    );
  }

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
          for (const [lang, code] of [['c', example.code.c], ['cpp', example.code.cpp]] as const) {
            runSingleCode(code, target, osType, dataModel, `${example.name}/${lang}/${target}/${osType}/${dataModel}`);
            executed += 1;
          }
        }
        for (const custom of customCases) {
          const { result, packed } = runSingleCode(
            custom.code,
            target,
            osType,
            dataModel,
            `${custom.name}/${target}/${osType}/${dataModel}`
          );
          custom.run(result, packed);
          executed += 1;
        }
      }
    }
  }

  assert.ok(executed > 0, 'expected at least one test execution');
  return executed;
}

it("layout invariants hold for every example on every target × data model × OS", () => {
  const executed = runMatrixCoverage();
  // 1240 at the monorepo migration: 14 examples × 2 languages + 3 custom cases, over 40 platform combos.
  assert.equal(executed, 1240);
});
