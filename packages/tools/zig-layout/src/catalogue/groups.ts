import type { OptionGroupMeta } from "@sp/engine";

export type ZigGroup = "platform" | "layout";

export const OPTION_GROUP_META: Record<ZigGroup, OptionGroupMeta> = {
  platform: {
    id: "platform",
    label: "Target",
    summary: "The target decides pointer size and how integers, floats and vectors are aligned; the build mode decides whether bare unions carry a safety tag.",
    order: 0,
  },
  layout: {
    id: "layout",
    label: "Layout",
    summary: "The layout Zig produces, or an extern struct with its fields reordered.",
    order: 1,
  },
};
