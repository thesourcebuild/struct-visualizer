import { FAMILY_ORDER, getManifest, isLanguageFamily } from "@sp/registry";
import type { ToolFamily } from "@sp/engine";

/**
 * The workbench's saved state, read back from localStorage: untrusted JSON that another version
 * of the site, an extension or a hand edit may have written. Each value is checked on its own and
 * falls back on its own (undefined: use the default), so one bad value never discards the others.
 */

/** A saved editor input: a string; an empty one (or anything else) gives the language's sample. */
export function readSavedInput(saved: unknown): string | undefined {
  return typeof saved === "string" && saved !== "" ? saved : undefined;
}

/** The last tool opened: the id of a tool that exists. */
export function readSavedToolId(saved: unknown): string | undefined {
  return typeof saved === "string" && getManifest(saved) ? saved : undefined;
}

/** The sidebar's language: a family that is a source language. */
export function readSavedLanguage(saved: unknown): ToolFamily | undefined {
  return FAMILY_ORDER.find((family) => family === saved && isLanguageFamily(family));
}

/** The collapsed sidebar groups: the known families in a saved array; anything else is dropped. */
export function readCollapsedFamilies(saved: unknown): ToolFamily[] {
  return Array.isArray(saved) ? FAMILY_ORDER.filter((family) => saved.includes(family)) : [];
}
