import type { OptionGroupMeta } from "@sp/engine";

export type RustGroup = "platform" | "layout";

export const OPTION_GROUP_META: Record<RustGroup, OptionGroupMeta> = {
  platform: {
    id: "platform",
    label: "Target",
    summary: "The target triple decides pointer size and how u64, f64 and u128 are aligned.",
    order: 0,
  },
  layout: {
    id: "layout",
    label: "Layout",
    summary: "The layout rustc produces, or a repr(C) struct with its fields reordered.",
    order: 1,
  },
};
