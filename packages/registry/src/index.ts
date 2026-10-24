import type { AnyToolDefinition, ToolFamily, ToolManifest } from "@sp/engine";
import { GO_MANIFESTS } from "@sp/go-layout/manifests";
import { LAYOUT_MANIFESTS } from "@sp/layout/manifests";
import { RUST_MANIFESTS } from "@sp/rust-layout/manifests";
import { ZIG_MANIFESTS } from "@sp/zig-layout/manifests";

/** Every tool, eagerly. Strings only — safe for the sidebar, sitemap and static params. */
export const TOOL_MANIFESTS: readonly ToolManifest[] = [...LAYOUT_MANIFESTS, ...GO_MANIFESTS, ...RUST_MANIFESTS, ...ZIG_MANIFESTS];

const BY_ID = new Map(TOOL_MANIFESTS.map((m) => [m.id, m]));

export const FAMILY_ORDER: readonly ToolFamily[] = ["layout", "go", "rust", "zig", "reference"];

export const FAMILY_LABEL: Record<ToolFamily, string> = {
  layout: "C / C++",
  go: "Go",
  rust: "Rust",
  zig: "Zig",
  reference: "Reference",
};

export const DEFAULT_TOOL_ID = "struct-layout";

export function getManifest(id: string): ToolManifest | undefined {
  return BY_ID.get(id);
}

export function manifestsInFamily(family: ToolFamily): ToolManifest[] {
  return TOOL_MANIFESTS.filter((m) => m.family === family);
}

export function presentFamilies(): ToolFamily[] {
  return FAMILY_ORDER.filter((f) => TOOL_MANIFESTS.some((m) => m.family === f));
}

/** Families that are a source language, chosen with the sidebar's language selector. */
const LANGUAGE_FAMILIES: readonly ToolFamily[] = ["layout", "go", "rust", "zig"];

export function isLanguageFamily(family: ToolFamily): boolean {
  return LANGUAGE_FAMILIES.includes(family);
}

/** Language families that have tools, in sidebar order. */
export function languageFamilies(): ToolFamily[] {
  return presentFamilies().filter(isLanguageFamily);
}

/**
 * The tool to open when switching to another language: the one in the same position (layout
 * for layout, verification for verification), or the language's first tool.
 */
export function equivalentTool(currentId: string, family: ToolFamily): string | undefined {
  const target = manifestsInFamily(family);
  const current = BY_ID.get(currentId);
  const index = current ? manifestsInFamily(current.family).findIndex((m) => m.id === currentId) : -1;
  return (target[index] ?? target[0])?.id;
}

/**
 * Lazily load a tool's full definition. One case per *package*, each a literal import()
 * so bundlers split the heavy code out of the initial chunk.
 */
export async function loadTool(id: string): Promise<AnyToolDefinition> {
  const manifest = BY_ID.get(id);
  if (!manifest) throw new Error(`Unknown tool id: ${id}`);
  switch (manifest.family) {
    case "layout":
    case "reference": {
      const { layoutToolDefinition } = await import("@sp/layout/definition");
      return layoutToolDefinition(id) as unknown as AnyToolDefinition;
    }
    case "go": {
      const { goToolDefinition } = await import("@sp/go-layout/definition");
      return goToolDefinition(id) as unknown as AnyToolDefinition;
    }
    case "rust": {
      const { rustToolDefinition } = await import("@sp/rust-layout/definition");
      return rustToolDefinition(id) as unknown as AnyToolDefinition;
    }
    case "zig": {
      const { zigToolDefinition } = await import("@sp/zig-layout/definition");
      return zigToolDefinition(id) as unknown as AnyToolDefinition;
    }
  }
}
