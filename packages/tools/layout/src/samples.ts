import { examples } from "@sp/core";
import type { ToolSample } from "@sp/engine";
import { OPTION_LANGUAGE } from "./pure";

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The bundled examples. A C++ one also selects C++; the C ones are valid C++ as well. */
export function layoutSamples(): ToolSample[] {
  return examples.map((e) => ({
    id: slug(e.name),
    label: e.name,
    input: e.code,
    ...(e.language !== "c" && { options: { [OPTION_LANGUAGE]: e.language } }),
  }));
}

export const DEFAULT_INPUT = examples[0]!.code;
