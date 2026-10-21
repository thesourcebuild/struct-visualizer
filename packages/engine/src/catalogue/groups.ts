export interface OptionGroupMeta {
  id: string;
  label: string;
  summary?: string;
  order: number;
  collapsedByDefault?: boolean;
  columns?: 1 | 2;
}

export function groupsInOrder(groups: Record<string, OptionGroupMeta>): OptionGroupMeta[] {
  return Object.values(groups).sort((a, b) => a.order - b.order);
}
