import { memberLabel, memberTypeLabel } from '@sp/core';
import type { CalculationResult } from '@sp/core';

export interface StatExplanations {
  size: string;
  padding: string;
  efficiency: string;
  alignment: string;
}

const bytes = (n: number) => `${n} byte${n === 1 ? '' : 's'}`;
/** The verb after a count: "1 byte rounds", "2 bytes round". */
const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "a", "a and b", "a, b and c", then "a, b and 2 more". */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Why each Statistics number is what it is, worked out from this layout rather than written once:
 * the hover text on the cards. The same result shape comes from the C, Go, Rust and Zig engines, so the
 * wording stays language-neutral.
 */
export function explainStats(result: CalculationResult): StatExplanations {
  const size = result.totalSize;
  const align = result.struct.alignment ?? 1;
  const union = result.struct.isUnion === true && result.struct.isEnum !== true;
  const between = result.members.reduce((sum, m) => sum + m.padding, 0);
  const trailing = Math.max(0, result.totalPadding - between);
  const end = size - trailing;
  const padding = result.totalPadding;
  const data = size - padding;
  const hasBitfields = result.members.some((m) => m.member.bitField !== undefined);
  const packing = result.struct.packed === true || result.struct.pragmaPack !== undefined;
  const gapReason = hasBitfields ? 'where alignment and the bit-field rules leave gaps' : 'so that each member starts on its alignment';
  const tailReason = `to round the size up to a multiple of ${align}`;

  const sizeText = union
    ? `A union is as large as its largest member (${bytes(end)})${
        trailing > 0 ? `, rounded up to ${size}, a multiple of its ${align}-byte alignment` : ''
      }. Every member starts at offset 0.`
    : trailing > 0
      ? `The members end at byte ${end}. ${bytes(trailing)} of trailing padding ${verb(trailing, 'rounds', 'round')} that up to ${size}, a multiple of the ${align}-byte alignment, so every element of an array of this type starts aligned too.`
      : `The members end at byte ${size}, already a multiple of the ${align}-byte alignment, so no trailing padding is needed.`;

  let paddingText: string;
  if (padding === 0) {
    paddingText = 'No byte goes unused: every member already starts where its alignment allows, and the size is already a multiple of the alignment.';
  } else if (trailing === 0) {
    paddingText = `${bytes(between)} between members hold no data, ${gapReason}.`;
  } else if (between === 0) {
    paddingText = `${bytes(trailing)} at the end ${verb(trailing, 'holds', 'hold')} no data, ${tailReason}.`;
  } else {
    paddingText = `${bytes(padding)} hold no data: ${bytes(between)} between members, ${gapReason}, and ${bytes(trailing)} at the end, ${tailReason}.`;
  }

  const efficiencyText =
    padding === 0
      ? `Every one of the ${bytes(size)} holds member data (100%).`
      : `${data} of the ${bytes(size)} ${verb(data, 'holds', 'hold')} member data (${result.efficiency.toFixed(1)}%); the other ${bytes(padding)} ${verb(padding, 'is', 'are')} padding.`;

  // The members that set the alignment: named ones, since an unnamed bit-field only counts on
  // some targets and its recorded alignment says what it would add, not that it did.
  const named = result.members.filter((m) => m.member.name);
  const largest = named.reduce((max, m) => Math.max(max, m.alignment), 1);
  const setters = named
    .filter((m) => m.alignment === largest)
    .map((m) => `${memberLabel(m.member)} (${memberTypeLabel(m.member)})`);
  const why = `A value of this type must start at an address that is a multiple of ${align}, and its size is a multiple of ${align}, so in an array every element stays aligned.`;
  let alignmentText: string;
  if (align === largest && align === 1) {
    alignmentText = packing
      ? 'Packing gives every member alignment 1, so a value of this type can start at any address, and members can sit at addresses that are not a multiple of their natural alignment.'
      : 'Every member has alignment 1, so a value of this type can start at any address and needs no padding for alignment.';
  } else if (align === largest) {
    alignmentText = `The largest alignment of any member: ${list(setters)} ${verb(setters.length, 'needs', 'need')} ${align}. ${why}`;
  } else if (align > largest) {
    const cause =
      result.struct.alignAttribute !== undefined
        ? 'An alignment request on the type (aligned or alignas) raises it'
        : hasBitfields
          ? 'On this target an unnamed or zero-width bit-field also counts, which raises it'
          : 'A request on the type or the target ABI raises it';
    alignmentText = `${cause} above the largest member alignment, ${largest}. ${why}`;
  } else {
    alignmentText = `${
      packing ? 'Packing lowers it' : 'The target caps it'
    } below the largest member alignment (${largest}, for ${list(setters)}), so those members can sit at addresses that are not a multiple of their own alignment.`;
  }

  return { size: sizeText, padding: paddingText, efficiency: efficiencyText, alignment: alignmentText };
}
