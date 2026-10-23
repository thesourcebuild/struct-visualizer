import type { ParsedStruct, StructMember } from '../types';
import { memberLabel } from '../display';
import { StructParser } from '../parser/struct-parser';
import type { ParserTarget } from '../parser/struct-parser';

export class CCodeGenerator {
  /**
   * A complete C or C++ program that prints sizeof and every member's offsetof for one
   * definition, so results can be checked against a real compiler. The source is included
   * verbatim; the member list comes from the same parser the calculator uses.
   */
  static generateVerificationCode(structCode: string, target: ParserTarget, structName?: string, language: 'c' | 'cpp' = 'c'): string {
    const parser = new StructParser(target);
    parser.parse(structCode);
    const def = (structName ? parser.getStruct(structName) ?? parser.getUnion(structName) : undefined) ?? parser.getLastDefinition();
    const name = def?.name ?? structName ?? 'Example';
    const keyword = def?.isUnion ? 'union' : 'struct';
    // `typedef struct { ... } Name;` has no tag: C must say `Name`, not `struct Name`. C++ names
    // any class by its name.
    const typeRef = language === 'cpp' || def?.nameIsTypedef ? name : `${keyword} ${name}`;
    const prints = def ? this.generateOffsetPrints(def, typeRef, language) : '';

    if (language === 'cpp') {
      const bases = def ? this.generateBasePrints(def) : '';
      return `#include <iostream>
#include <iomanip>
#include <cstddef>
#include <stdint.h>

${structCode}
${bases ? `\n// Storage for the base class offsets: static_cast to a non-virtual base is pointer arithmetic.\nalignas(${typeRef}) static unsigned char verify_storage[sizeof(${typeRef})];\n` : ''}
int main() {
    std::cout << "Size of ${typeRef}: " << sizeof(${typeRef}) << " bytes\\n";
    std::cout << "Alignment: " << alignof(${typeRef}) << " bytes\\n";
    std::cout << std::endl;
${bases ? `\n    ${typeRef} *object = reinterpret_cast<${typeRef} *>(verify_storage);\n${bases}\n` : ''}
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
   * One line per direct base class: its offset, where a cast can reach it. A non-virtual base the
   * class can convert to (public, and not there twice) is found by pointer arithmetic; a virtual
   * base's offset is read from the object at run time, which this program does not construct.
   */
  private static generateBasePrints(def: ParsedStruct): string {
    const occurrences = (rd: ParsedStruct, target: ParsedStruct): number =>
      (rd.cpp?.bases ?? []).reduce((n, b) => n + (b.def === target && !b.virtual ? 1 : 0) + (b.virtual ? 0 : occurrences(b.def, target)), 0);
    const line = (label: string, rest: string) => `    std::cout << "  " << std::setw(20) << std::left << "${label}" << ${rest} << std::endl;`;
    return (def.cpp?.bases ?? [])
      .map((b) => {
        const label = `${b.virtual ? 'virtual base' : 'base'} ${b.def.name}`;
        if (b.virtual) return line(label, '" virtual base (its offset needs a constructed object)"');
        if (b.access !== 'public') return line(label, `" ${b.access} base (no conversion outside the class)"`);
        if (occurrences(def, b.def) > 1) return line(label, '" base more than once (the conversion is ambiguous)"');
        const offset = `(reinterpret_cast<char *>(static_cast<${b.def.name} *>(object)) - reinterpret_cast<char *>(object))`;
        return line(label, `" offset: " << std::setw(3) << std::right << ${offset}`);
      })
      .join('\n');
  }

  /**
   * One line per member. offsetof is not allowed for bit-fields and cannot name an anonymous
   * member, and sizeof is not allowed for a flexible array member; those lines say so instead.
   */
  private static generateOffsetPrints(def: ParsedStruct, typeRef: string, language: 'c' | 'cpp'): string {
    return def.members
      .map((member) => {
        const label = memberLabel(member);
        if (!member.name || member.bitField !== undefined || member.access) {
          const note = member.access
            ? `${member.access} member (offsetof needs access to it)`
            : member.bitField !== undefined ? `bit-field, ${member.bitField} bits (offsetof not allowed)` : 'anonymous member (no name for offsetof)';
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
   * The definitions whose member order the optimization changed, in the order they need, written
   * from the declarations as the source has them (types as spelled, attributes, initializers, and
   * for C++ the bases, member functions and access), with only the order of the data members new.
   */
  static generateOptimizedCode(originalStruct: ParsedStruct, optimizedStruct: ParsedStruct): string {
    return this.optimizedDefinitions(originalStruct, optimizedStruct, false);
  }

  /**
   * A program source with the optimized layout in it: the source as written (which defines every
   * type the definitions use), then each definition the optimization changed again, named
   * `<name>_optimized`. Its root is getOptimizedRootName.
   */
  static generateOptimizedProgram(source: string, originalStruct: ParsedStruct, optimizedStruct: ParsedStruct): string {
    const copies = this.optimizedDefinitions(originalStruct, optimizedStruct, true);
    return copies ? `${source}\n\n/* The same definitions with their members in the optimized order. */\n${copies}` : source;
  }

  private static optimizedDefinitions(originalStruct: ParsedStruct, optimizedStruct: ParsedStruct, rename: boolean): string {
    const changeMap = new Map<string, boolean>();
    this.buildChangeMap(originalStruct, optimizedStruct, changeMap);
    const ctx: RenderContext = {
      cpp: optimizedStruct.cpp !== undefined,
      rename,
      changed: (d) => changeMap.get(this.getStructKey(d)) === true,
    };
    const definitions: string[] = [];
    const visited = new Set<string>();
    // A changed record defined elsewhere is written out on its own before what uses it; one defined
    // in place is written in place.
    const visit = (def: ParsedStruct, own: boolean) => {
      for (const m of def.members) {
        const t = m.isNested ? m.nestedStruct : undefined;
        if (!t) continue;
        if (inPlace(m, ctx)) visit(t, false);
        else if (ctx.changed(t)) visit(t, true);
      }
      const key = this.getStructKey(def);
      if (own && ctx.changed(def) && !visited.has(key)) {
        visited.add(key);
        definitions.push(renderRecord(def, nameOf(def, ctx), ctx));
      }
    };
    visit(optimizedStruct, true);
    return definitions.join('\n\n');
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

}

interface RenderContext {
  cpp: boolean;
  /** Write the changed definitions as `<name>_optimized`, next to the originals. */
  rename: boolean;
  changed: (def: ParsedStruct) => boolean;
}

/**
 * Tokens written back as C is usually spaced: `int *p`, `buf[4]`, `f(int a, char b)`, `a.b`,
 * `std::size_t`. Spacing never changes what tokens mean here, so this only reads better.
 */
function spellTokens(tokens: readonly string[]): string {
  let out = '';
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    const glued =
      i === 0 ||
      [')', ']', ',', ';', '.', '->', '::', '['].includes(t) ||
      (t === '(' && prev !== undefined && /\w$/.test(prev) && !['sizeof', 'alignas', '_Alignas', 'return', '__attribute__'].includes(prev)) ||
      ['(', '[', '.', '->', '::', '~', '!'].includes(prev!) ||
      // A declarator's pointer or reference goes with what follows it: `char *name`, `int &&r`.
      ((prev === '*' || prev === '&' || prev === '&&') && /^[A-Za-z_(*]/.test(t));
    out += glued ? t : ` ${t}`;
  });
  return out;
}

const isAnonymous = (def: ParsedStruct) => def.name.startsWith('__anon_');
const keywordOf = (def: ParsedStruct) => (def.isUnion ? 'union' : def.cpp?.key === 'class' ? 'class' : 'struct');
const nameOf = (def: ParsedStruct, ctx: RenderContext) => (ctx.rename && ctx.changed(def) ? `${def.name}_optimized` : def.name);

/**
 * Whether a member's record type is written where the member is: an anonymous one always, and one
 * the source defines in the member's declaration, except in C next to the originals, where that
 * tag already names the original's type (C tags are not scoped) and is referred to instead.
 */
function inPlace(m: StructMember, ctx: RenderContext): boolean {
  const t = m.nestedStruct;
  return !!t && m.source?.inlineType === true && (isAnonymous(t) || ctx.cpp || !ctx.rename);
}

function renderRecord(def: ParsedStruct, name: string, ctx: RenderContext): string {
  const body = renderBody(def, name, ctx);
  const text = def.nameIsTypedef ? `typedef ${body} ${name};` : `${body};`;
  return def.pragmaPack !== undefined ? `#pragma pack(push, ${def.pragmaPack})\n${text}\n#pragma pack(pop)` : text;
}

/** `struct Tag : bases { ... } attributes`, with the data members in their (optimized) order. */
function renderBody(def: ParsedStruct, name: string | undefined, ctx: RenderContext): string {
  const head = [...(def.source?.head ?? [keywordOf(def)])];
  if (name !== undefined && !def.nameIsTypedef && !isAnonymous(def)) {
    const at = head.indexOf(def.name, 1);
    if (at > 0) head[at] = name;
  }
  // A C++ class copy names itself in its constructors, destructor and operator=.
  const rename = (tokens: readonly string[]) =>
    ctx.cpp && name !== undefined && name !== def.name ? tokens.map((t) => (t === def.name ? name : t)) : [...tokens];
  const lines: string[] = [];
  // C++: each declaration keeps its access; a label goes where the access changes.
  let access = def.cpp?.key === 'class' ? 'private' : 'public';
  const withAccess = (a: string, line: string) => {
    if (ctx.cpp && a !== access) {
      lines.push(`${a}:`);
      access = a;
    }
    lines.push(line);
  };
  // C has nothing but data members that matters; a nested C struct definition is file scope and
  // would be defined twice.
  if (ctx.cpp) for (const d of def.declarations ?? []) withAccess(d.access ?? 'public', `${spellTokens(rename(d.tokens))}`);
  for (const m of def.members) withAccess(m.access ?? 'public', renderMember(m, ctx, rename));
  const tail = def.source && def.source.tail.length > 0 ? ` ${spellTokens(def.source.tail)}` : '';
  return `${spellTokens(head)} {\n${lines.map((l) => `    ${l.replace(/\n/g, '\n    ')}`).join('\n')}\n}${tail}`;
}

function renderMember(m: StructMember, ctx: RenderContext, rename: (tokens: readonly string[]) => string[]): string {
  const src = m.source;
  if (!src) throw new Error(`Member '${m.name}' has no source to write out.`);
  const t = m.isNested ? m.nestedStruct : undefined;
  let spec: string;
  if (t && inPlace(m, ctx)) {
    // What precedes the record keyword (const, alignas, attributes), then the record itself.
    const keyword = src.spec.findIndex((s) => s === 'struct' || s === 'union' || s === 'class');
    const prefix = keyword > 0 ? `${spellTokens(src.spec.slice(0, keyword))} ` : '';
    spec = `${prefix}${renderBody(t, isAnonymous(t) ? undefined : t.name, ctx)}`;
  } else if (t && ctx.rename && ctx.changed(t)) {
    const cv = src.spec.filter((s) => s === 'const' || s === 'volatile');
    spec = [...cv, ...(ctx.cpp ? [] : [keywordOf(t)]), nameOf(t, ctx)].join(' ');
  } else {
    spec = spellTokens(rename(src.spec));
  }
  return `${spec}${src.declarator.length > 0 ? ` ${spellTokens(rename(src.declarator))}` : ''};`;
}
