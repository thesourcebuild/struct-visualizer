import type { AlignRequest, ParsedStruct, StructMember } from '../types';
import { memberLabel } from '../display';
import { StructParser } from '../parser/struct-parser';

export class CCodeGenerator {
  /**
   * A complete C or C++ program that prints sizeof and every member's offsetof for one
   * definition, so results can be checked against a real compiler. The source is included
   * verbatim; the member list comes from the same parser the calculator uses.
   */
  static generateVerificationCode(structCode: string, structName?: string, language: 'c' | 'cpp' = 'c'): string {
    const parser = new StructParser();
    parser.parse(structCode);
    const def = (structName ? parser.getStruct(structName) ?? parser.getUnion(structName) : undefined) ?? parser.getLastDefinition();
    const name = def?.name ?? structName ?? 'Example';
    const keyword = def?.isUnion ? 'union' : 'struct';
    // `typedef struct { ... } Name;` has no tag: C must say `Name`, not `struct Name`.
    const typeRef = def?.nameIsTypedef ? name : `${keyword} ${name}`;
    const prints = def ? this.generateOffsetPrints(def, typeRef, language) : '';

    if (language === 'cpp') {
      return `#include <iostream>
#include <iomanip>
#include <cstddef>
#include <stdint.h>

${structCode}

int main() {
    std::cout << "Size of ${typeRef}: " << sizeof(${typeRef}) << " bytes\\n";
    std::cout << "Alignment: " << alignof(${typeRef}) << " bytes\\n";
    std::cout << std::endl;

${prints}

    return 0;
}`;
    }

    return `#include <stdio.h>
#include <stddef.h>
#include <stdint.h>

${structCode}

int main(void) {
    printf("Size of ${typeRef}: %zu bytes\\n", sizeof(${typeRef}));
    printf("Alignment: %zu bytes\\n", (size_t)_Alignof(${typeRef}));
    printf("\\n");

${prints}

    return 0;
}`;
  }

  /**
   * One line per member. offsetof is not allowed for bit-fields and cannot name an anonymous
   * member, and sizeof is not allowed for a flexible array member; those lines say so instead.
   */
  private static generateOffsetPrints(def: ParsedStruct, typeRef: string, language: 'c' | 'cpp'): string {
    return def.members
      .map((member) => {
        const label = memberLabel(member);
        if (!member.name || member.bitField !== undefined) {
          const note = member.bitField !== undefined ? `bit-field, ${member.bitField} bits (offsetof not allowed)` : 'anonymous member (no name for offsetof)';
          return language === 'cpp'
            ? `    std::cout << "  " << std::setw(20) << std::left << "${label}" << " ${note}" << std::endl;`
            : `    printf("    %-16s ${note}\\n", "${label}");`;
        }
        const offset = `offsetof(${typeRef}, ${member.name})`;
        const isFlexible = member.arraySize === 0 && member.arrayDims?.[0] === 0;
        if (language === 'cpp') {
          const size = isFlexible ? '"flexible array"' : `sizeof(((${typeRef}*)0)->${member.name})`;
          return `    std::cout << "  " << std::setw(20) << std::left << "${label}" << " offset: " << std::setw(3) << std::right << ${offset} << ", size: " << ${size} << std::endl;`;
        }
        return isFlexible
          ? `    printf("    %-16s offset: %3zu, size: flexible array\\n", "${label}", ${offset});`
          : `    printf("    %-16s offset: %3zu, size: %zu\\n", "${label}", ${offset}, sizeof(((${typeRef}*)0)->${member.name}));`;
      })
      .join('\n');
  }

  /**
   * Generate optimized code including nested optimized definitions
   */
  static generateOptimizedCode(originalStruct: ParsedStruct, optimizedStruct: ParsedStruct): string {
    const definitions: string[] = [];
    const visited = new Set<string>();
    const changeMap = new Map<string, boolean>();

    this.buildChangeMap(originalStruct, optimizedStruct, changeMap);

    const collectNested = (optimizedItem: ParsedStruct, originalItem?: ParsedStruct) => {
      const key = this.getStructKey(optimizedItem);
      if (visited.has(key)) return;
      visited.add(key);

      for (const member of optimizedItem.members) {
        if (member.isNested && member.nestedStruct) {
          const originalNested = originalItem?.members.find((m) => m.name === member.name)?.nestedStruct;
          collectNested(member.nestedStruct, originalNested);
        }
      }

      definitions.push(this.buildOptimizedDefinitionWithMap(optimizedItem, changeMap));
    };

    collectNested(optimizedStruct, originalStruct);

    return definitions.filter(Boolean).join('\n\n');
  }

  static getOptimizedRootName(originalStruct: ParsedStruct, optimizedStruct: ParsedStruct): string {
    const changeMap = new Map<string, boolean>();
    this.buildChangeMap(originalStruct, optimizedStruct, changeMap);
    const rootKey = this.getStructKey(optimizedStruct);
    return changeMap.get(rootKey) ? `${optimizedStruct.name}_optimized` : optimizedStruct.name;
  }

  private static getStructKey(item: ParsedStruct): string {
    return `${item.isUnion ? 'union' : 'struct'}:${item.name}`;
  }

  private static sameMembers(a: ParsedStruct, b: ParsedStruct): boolean {
    if (a.members.length !== b.members.length) return false;

    for (let i = 0; i < a.members.length; i++) {
      const am = a.members[i];
      const bm = b.members[i];

      if (
        am.name !== bm.name ||
        am.type !== bm.type ||
        am.arraySize !== bm.arraySize ||
        am.bitField !== bm.bitField ||
        am.isNested !== bm.isNested ||
        (am.nestedStruct?.name ?? null) !== (bm.nestedStruct?.name ?? null)
      ) {
        return false;
      }
    }

    return true;
  }

  private static buildChangeMap(
    originalStruct: ParsedStruct,
    optimizedStruct: ParsedStruct,
    changeMap: Map<string, boolean>
  ): void {
    let changed = !this.sameMembers(originalStruct, optimizedStruct);

    for (const member of optimizedStruct.members) {
      if (member.isNested && member.nestedStruct) {
        const originalNested = originalStruct.members.find((m) => m.name === member.name)?.nestedStruct;

        if (originalNested) {
          this.buildChangeMap(originalNested, member.nestedStruct, changeMap);
          const nestedKey = this.getStructKey(member.nestedStruct);
          if (changeMap.get(nestedKey)) {
            changed = true;
          }
        } else {
          changed = true;
        }
      }
    }

    changeMap.set(this.getStructKey(optimizedStruct), changed);
  }

  private static buildOptimizedDefinitionWithMap(
    parsedStruct: ParsedStruct,
    changeMap: Map<string, boolean>
  ): string {
    const key = this.getStructKey(parsedStruct);
    const structName = changeMap.get(key) ? `${parsedStruct.name}_optimized` : parsedStruct.name;
    return this.renderDefinition(parsedStruct, structName, (nested) =>
      changeMap.get(this.getStructKey(nested)) ? `${nested.name}_optimized` : nested.name,
    );
  }

  /**
   * One definition as C source, carrying everything that affects layout: packing (as a
   * #pragma pack wrapper or the packed attribute), struct and member alignment attributes,
   * bit-fields (including unnamed and zero-width ones) and array dimensions as written.
   */
  private static renderDefinition(
    parsedStruct: ParsedStruct,
    structName: string,
    nestedName: (nested: ParsedStruct) => string,
  ): string {
    const keyword = parsedStruct.isUnion ? 'union' : 'struct';
    const lines = parsedStruct.members.map((member, index) => {
      let memberType = member.type;
      if (member.isNested && member.nestedStruct) {
        memberType = `${member.nestedStruct.isUnion ? 'union' : 'struct'} ${nestedName(member.nestedStruct)}`;
      }
      return `    ${this.renderMember(member, memberType, index)};`;
    });

    const pack = parsedStruct.pragmaPack;
    const attributes: string[] = [];
    if (parsedStruct.packed) attributes.push('packed');
    if (parsedStruct.alignAttribute !== undefined) attributes.push(this.renderAligned(parsedStruct.alignAttribute));
    const trailer = attributes.length > 0 ? ` __attribute__((${attributes.join(', ')}))` : '';

    const body = `${keyword} ${structName} {\n${lines.join('\n')}${lines.length ? '\n' : ''}}${trailer};`;
    return pack !== undefined ? `#pragma pack(push, ${pack})\n${body}\n#pragma pack(pop)` : body;
  }

  private static renderMember(member: StructMember, memberType: string, index: number): string {
    // A C11 anonymous member is emitted as its named type definition, so it needs a name here.
    const name = member.name || (member.bitField === undefined ? `__anonymous_${index}` : '');
    const dims = member.arrayDims
      ? member.arrayDims.map((d, i) => (d === 0 && i === 0 && member.arraySize === 0 ? '[]' : `[${d}]`)).join('')
      : member.arraySize !== undefined
        ? `[${member.arraySize}]`
        : '';
    const alignas = typeof member.alignAttribute === 'object' ? `_Alignas(${member.alignAttribute.ofType}) ` : '';
    const attributes: string[] = [];
    if (member.packed) attributes.push('packed');
    if (member.alignAttribute !== undefined && typeof member.alignAttribute !== 'object') {
      attributes.push(this.renderAligned(member.alignAttribute));
    }
    const trailer = attributes.length > 0 ? ` __attribute__((${attributes.join(', ')}))` : '';
    const bits = member.bitField !== undefined ? ` : ${member.bitField}` : '';
    return `${alignas}${memberType}${name ? ` ${name}` : ''}${dims}${bits}${trailer}`;
  }

  private static renderAligned(request: AlignRequest): string {
    if (request === 'max') return 'aligned';
    if (typeof request === 'number') return `aligned(${request})`;
    return `aligned(_Alignof(${request.ofType}))`;
  }
}
