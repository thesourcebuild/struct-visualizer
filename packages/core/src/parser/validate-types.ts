import type { Architecture, ParseError, StructMember } from '../types';
import { getStandardTypeMap } from '../abi/data-models';
import type { DataModel } from '../abi/data-models';
import type { StructParser } from './struct-parser';

const normalizeTypeForLookup = (type: string) =>
  type
    .replace(/\*/g, '')
    .replace(/\bconst\b/g, '')
    .replace(/\bvolatile\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Reject member types the calculator has no size/alignment for, so results are never
 * silently computed with the 4/4 fallback. Runs after a successful parse.
 */
export function validateSupportedTypes(
  parser: StructParser,
  dataModel: DataModel,
  architecture: Architecture,
): ParseError[] {
  const errors: ParseError[] = [];
  const standardTypes = getStandardTypeMap(dataModel);
  const allowedTypes = new Set<string>([
    ...Object.keys(standardTypes),
    ...Object.keys(architecture.dataTypes ?? {}),
  ]);
  const knownStructs = new Set<string>([
    ...parser.getAllStructs().map((struct) => struct.name),
    ...parser.getAllUnions().map((union) => union.name),
  ]);
  const knownEnums = new Set<string>(parser.getAllEnums().map((enumType) => enumType.name));

  const validateMember = (member: StructMember, ownerName: string) => {
    if (member.isNested && member.nestedStruct) return;
    if (member.enumType) return;
    // Pointer targets may be externally defined/incomplete types; pointer size is known.
    if (member.type.includes('*')) return;

    const normalizedType = normalizeTypeForLookup(member.type);
    if (!normalizedType) return;

    for (const keyword of ['struct', 'union', 'enum'] as const) {
      if (normalizedType.startsWith(`${keyword} `)) {
        const name = normalizedType.slice(keyword.length + 1).trim();
        const known = keyword === 'enum' ? knownEnums : knownStructs;
        if (!known.has(name)) {
          errors.push({
            message: `Unknown ${keyword} type '${name}' in member '${member.name}' of '${ownerName}'.`,
            type: 'semantic',
          });
        }
        return;
      }
    }

    if (knownStructs.has(normalizedType) || knownEnums.has(normalizedType)) return;

    if (!allowedTypes.has(normalizedType)) {
      errors.push({
        message: `Unsupported type '${normalizedType}' in member '${member.name}' of '${ownerName}'.`,
        type: 'semantic',
      });
    }
  };

  for (const struct of parser.getAllStructs()) {
    for (const member of struct.members) validateMember(member, struct.name);
  }
  for (const union of parser.getAllUnions()) {
    for (const member of union.members) validateMember(member, union.name);
  }

  return errors;
}
