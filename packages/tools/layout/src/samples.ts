import { examples } from "@sp/core";
import type { ToolSample } from "@sp/engine";

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The bundled examples, one sample per language variant. */
export function layoutSamples(language: "c" | "cpp"): ToolSample[] {
  return examples.map((e) => ({ id: slug(e.name), label: e.name, input: e.code[language] }));
}

export const DEFAULT_INPUT = examples[0]!.code.c;
