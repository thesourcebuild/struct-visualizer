import type { ToolManifest } from "@sp/engine";
import { RUST_TOOLS } from "./catalogue/tool-meta";

/** Eager, strings only. Must not import @sp/core. */
export const RUST_MANIFESTS: readonly ToolManifest[] = RUST_TOOLS.map((t) => ({
  id: t.id,
  label: t.label,
  family: t.family,
  category: t.category,
  tags: t.tags,
  summary: t.summary,
  readsInput: true,
  inputLanguage: "rust",
  supportsVariants: t.supportsVariants,
}));
