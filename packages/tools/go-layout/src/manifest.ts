import type { ToolManifest } from "@sp/engine";
import { GO_TOOLS } from "./catalogue/tool-meta";

/** Eager, strings only. Must not import @sp/core. */
export const GO_MANIFESTS: readonly ToolManifest[] = GO_TOOLS.map((t) => ({
  id: t.id,
  label: t.label,
  family: t.family,
  category: t.category,
  tags: t.tags,
  summary: t.summary,
  readsInput: true,
  inputLanguage: "go",
  supportsVariants: t.supportsVariants,
}));
