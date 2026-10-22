import type { CalculationResult, ParseError, ParsedStruct } from './types';
import { StructParser } from './parser/struct-parser';
import { validateSupportedTypes } from './parser/validate-types';
import { PaddingCalculator } from './layout/padding-calculator';
import { resolvePlatform } from './abi/resolve-selection';
import type { PlatformSelection, ResolvedPlatform } from './abi/resolve-selection';
import { applyPacking, resolvePackingSyntax } from './packing';
import type { PackingSyntax } from './packing';

export interface StructAnalysis {
  platform: ResolvedPlatform;
  /** Parse + type-validation errors. When non-empty, the layout fields are null. */
  errors: ParseError[];
  warnings: ParseError[];
  /** The definition being laid out (the last one in the source). */
  definition: ParsedStruct | null;
  /**
   * Named struct/union definitions that the laid-out definition does not use, directly or through
   * nested members. These are the ones a reader might expect to see and will not.
   */
  unusedDefinitions: string[];
  enumDetected: boolean;
  result: CalculationResult | null;
  /** The layout with every definition packed in `packing` (see applyPacking). */
  packed: CalculationResult | null;
  /** The packing syntax `packed` uses: the one asked for if the target's compiler accepts it. */
  packing: PackingSyntax;
  optimized: CalculationResult | null;
  /** Types that fell back to the 4/4 default during calculation. */
  unknownTypes: string[];
}

/**
 * The one pipeline from C source + platform selection to layouts: parse, validate types,
 * then compute the natural, packed and optimized layouts of the last definition. The packed
 * layout is that of the source with packing written into it in `packing`, so it is exactly what
 * a compiler given that source produces.
 */
export function analyzeStruct(code: string, selection: PlatformSelection, packing?: PackingSyntax): StructAnalysis {
  const platform = resolvePlatform(selection);
  const syntax = resolvePackingSyntax(platform.os, platform.dataModel, packing);
  const parser = new StructParser();
  const validation = parser.parse(code);
  const typeErrors = validation.isValid
    ? validateSupportedTypes(parser, platform.dataModel, platform.architecture)
    : [];
  const errors = [...validation.errors, ...typeErrors];

  const analysis: StructAnalysis = {
    platform,
    errors,
    warnings: validation.warnings,
    definition: null,
    unusedDefinitions: [],
    enumDetected: parser.getAllEnums().length > 0,
    result: null,
    packed: null,
    packing: syntax,
    optimized: null,
    unknownTypes: [],
  };

  if (errors.length > 0) return analysis;

  const definition = parser.getLastDefinition();
  if (!definition) return analysis;

  const calculator = new PaddingCalculator(platform.architecture, platform.dataModel);
  analysis.definition = definition;
  analysis.unusedDefinitions = findUnusedDefinitions(
    definition,
    [...parser.getAllStructs(), ...parser.getAllUnions()],
    (name) => parser.resolveRecord(name),
  );
  analysis.result = calculator.calculate(definition);
  analysis.packed = packedLayout(applyPacking(code, syntax), platform);
  analysis.optimized = calculator.compareLayouts(definition).optimized;
  analysis.unknownTypes = calculator.getUnknownTypes();
  return analysis;
}

/** The last definition of already-packed source, laid out on `platform`. */
function packedLayout(code: string, platform: ResolvedPlatform): CalculationResult | null {
  const parser = new StructParser();
  if (!parser.parse(code).isValid) return null;
  const definition = parser.getLastDefinition();
  return definition ? new PaddingCalculator(platform.architecture, platform.dataModel).calculate(definition) : null;
}

const ANONYMOUS_PREFIX = '__anon_';

function definitionKey(def: ParsedStruct): string {
  return `${def.isUnion ? 'union' : 'struct'} ${def.name}`;
}

/**
 * Named definitions not used by `root`, directly or transitively. A definition counts as used
 * when it is a member by value or is pointed to (including from a function pointer's
 * parameters): a pointed-to struct is part of the design even though it is not laid out inline.
 * Anonymous inline types are registered by the parser under generated names and never count.
 */
function findUnusedDefinitions(
  root: ParsedStruct,
  all: readonly ParsedStruct[],
  resolve: (name: string) => ParsedStruct | undefined,
): string[] {
  const reachable = new Set<string>();
  const visit = (def: ParsedStruct) => {
    const key = definitionKey(def);
    if (reachable.has(key)) return;
    reachable.add(key);
    for (const member of def.members) {
      if (member.nestedStruct) visit(member.nestedStruct);
      for (const text of [member.type, member.declaredType ?? '']) {
        // `struct X*`, `union X*`, typedef names (`Node*`) and function-pointer parameters.
        for (const [, name] of text.matchAll(/\b(?:struct|union)\s+(\w+)/g)) {
          const target = resolve(name);
          if (target) visit(target);
        }
        const bare = /^(\w+)\s*\*/.exec(text)?.[1];
        const target = bare ? resolve(bare) : undefined;
        if (target) visit(target);
      }
    }
  };
  visit(root);
  return all
    .filter((def) => !def.name.startsWith(ANONYMOUS_PREFIX) && !reachable.has(definitionKey(def)))
    .map(definitionKey);
}
