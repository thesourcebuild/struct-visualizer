import type { OptionGroupMeta } from "@sp/engine";

export type GoGroup = "platform" | "layout";

export const OPTION_GROUP_META: Record<GoGroup, OptionGroupMeta> = {
  platform: {
    id: "platform",
    label: "Target",
    summary: "With gc, layout depends only on GOARCH: the word size and the largest alignment.",
    order: 0,
  },
  layout: {
    id: "layout",
    label: "Layout",
    summary: "Fields as declared, or in the order the fieldalignment analyzer suggests.",
    order: 1,
  },
};
