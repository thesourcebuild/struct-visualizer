import { bindingLanguages, dataModels, osTypes, targetArchitectures } from "@sp/core";
import { readReferenceModel } from "../create-spec";
import { resolveSpec } from "../resolve";
import { readBindingLanguage, readLanguage, readMode } from "../pure";
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
  const lang = { c: "C", "c++17": "C++17", "c++20": "C++20" }[readLanguage(spec.options)];
  const which = readMode(spec.options) === "optimized" ? "optimized" : "original";
  return `${lang} program printing sizeof/offsetof for the ${which} definition; compare with ${platformPhrase(spec)}.`;
}

export function describeDataModels(spec: LayoutSpec): string {
  return `Primitive type sizes for ${readReferenceModel(spec.options)}, plus every data model and target.`;
}

export function describeBindings(spec: LayoutSpec): string {
  const language = bindingLanguages[readBindingLanguage(spec.options)].label;
  return `The struct in ${language}, with its C size and member offsets on ${platformPhrase(spec)}, ${MODE_PHRASE[readMode(spec.options)]}.`;
}
