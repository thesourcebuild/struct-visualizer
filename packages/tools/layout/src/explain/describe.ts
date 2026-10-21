import { dataModels, osTypes, targetArchitectures } from "@sp/core";
import { resolveSpec } from "../resolve";
import { OPTION_REFERENCE_MODEL, readLanguage, readMode, readString } from "../pure";
import type { LayoutSpec } from "../spec";

const MODE_PHRASE = {
  natural: "natural alignment",
  packed: "packed (no padding)",
  optimized: "members reordered for minimal padding",
} as const;

function platformPhrase(spec: LayoutSpec): string {
  const p = resolveSpec(spec);
  const os = p.os === "none" ? "bare metal" : (osTypes[p.os]?.displayName ?? p.os);
  return `${targetArchitectures[p.target]?.displayName ?? p.target} ${os} (${dataModels[p.dataModel]?.displayName ?? p.dataModel})`;
}

export function describeLayout(spec: LayoutSpec): string {
  return `Memory layout on ${platformPhrase(spec)}, ${MODE_PHRASE[readMode(spec.options)]}.`;
}

export function describeVerification(spec: LayoutSpec): string {
  const lang = readLanguage(spec.options) === "cpp" ? "C++" : "C";
  const which = readMode(spec.options) === "optimized" ? "optimized" : "original";
  return `${lang} program printing sizeof/offsetof for the ${which} definition; compare with ${platformPhrase(spec)}.`;
}

export function describeDataModels(spec: LayoutSpec): string {
  const id = readString(spec.options, OPTION_REFERENCE_MODEL, "LP64");
  return `Primitive type sizes for ${id}, plus every data model and target.`;
}
