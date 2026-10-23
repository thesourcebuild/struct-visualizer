import type { StructMember } from './types';

/** A member's name for display; unnamed bit-fields and anonymous members get a description. */
export function memberLabel(member: StructMember): string {
  if (member.role === 'base') return `base ${member.name}`;
  if (member.role === 'virtual-base') return `virtual base ${member.name}`;
  if (member.role) return member.name;
  if (member.name) return member.name;
  if (member.bitField === 0) return '(zero-width bit-field)';
  if (member.bitField !== undefined) return '(unnamed bit-field)';
  return member.nestedStruct?.isUnion ? '(anonymous union)' : '(anonymous struct)';
}

/** The type as the user wrote it: a typedef name or function-pointer type when there is one. */
export function memberTypeLabel(member: StructMember): string {
  return member.declaredType ?? member.type;
}

/** Name plus array dimensions and bit width, e.g. `grid[3][4]`, `data[]`, `flags:3`. */
export function memberDeclarator(member: StructMember): string {
  const dims = member.arrayDims
    ? member.arrayDims.map((d, i) => (i === 0 && d === 0 && member.arraySize === 0 ? '[]' : `[${d}]`)).join('')
    : member.arraySize !== undefined
      ? `[${member.arraySize}]`
      : '';
  const bits = member.bitField !== undefined ? `:${member.bitField}` : '';
  return `${member.name && !member.role ? member.name : memberLabel(member)}${dims}${bits}`;
}
