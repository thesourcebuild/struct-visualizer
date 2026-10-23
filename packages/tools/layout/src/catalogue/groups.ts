import type { OptionGroupMeta } from "@sp/engine";

export type LayoutGroup = "platform" | "layout" | "enum" | "output";

export const OPTION_GROUP_META: Record<LayoutGroup, OptionGroupMeta> = {
  platform: {
    id: "platform",
    label: "Target platform",
    summary: "Language, CPU, data model and OS together pick the ABI the layout follows.",
    order: 0,
  },
  layout: {
    id: "layout",
    label: "Layout",
    summary: "Natural alignment, packed (no padding) or members reordered for minimal padding.",
    order: 1,
  },
  enum: {
    id: "enum",
    label: "Enum defaults",
    summary: "Override the size and alignment the data model assigns to plain enums.",
    order: 2,
    collapsedByDefault: true,
  },
  output: {
    id: "output",
    label: "Output",
    order: 3,
  },
};
