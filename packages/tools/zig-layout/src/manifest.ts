import type { ToolManifest } from "@sp/engine";
import { ZIG_TOOLS } from "./catalogue/tool-meta";

/** Eager, strings only. Must not import @sp/core. */
export const ZIG_MANIFESTS: readonly ToolManifest[] = ZIG_TOOLS.map((t) => ({
  id: t.id,
  label: t.label,
  family: t.family,
  category: t.category,
  tags: t.tags,
  summary: t.summary,
  readsInput: true,
  inputLanguage: "zig",
  supportsVariants: t.supportsVariants,
}));
