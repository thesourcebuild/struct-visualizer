import { examples } from "@sp/core";
import type { ToolSample } from "@sp/engine";
import { OPTION_LANGUAGE } from "./pure";

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The bundled examples. A C++ one also selects C++; the C ones are valid C++ as well. `cOnly`
 * for a tool the C++ examples do not apply to (their base classes have no binding).
 */
export function layoutSamples(options: { cOnly?: boolean } = {}): ToolSample[] {
  return examples.filter((e) => !options.cOnly || e.language === "c").map((e) => ({
    id: slug(e.name),
    label: e.name,
    input: e.code,
    ...(e.language !== "c" && { options: { [OPTION_LANGUAGE]: e.language } }),
  }));
}

export const DEFAULT_INPUT = examples[0]!.code;
