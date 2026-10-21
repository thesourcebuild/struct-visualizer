import type { ToolManifest } from "@sp/engine";
import { LAYOUT_TOOLS } from "./catalogue/tool-meta";

/** Eager, strings only. Must not import @sp/core. */
export const LAYOUT_MANIFESTS: readonly ToolManifest[] = LAYOUT_TOOLS.map((t) => ({
  id: t.id,
  label: t.label,
  family: t.family,
  category: t.category,
  tags: t.tags,
  summary: t.summary,
  readsInput: t.readsInput,
  inputLanguage: t.readsInput ? "c" : undefined,
  supportsVariants: t.supportsVariants,
}));
