"use client";

import type { LayoutData } from "@sp/layout/compute";
import { OPTION_COMPARE, OPTION_EXPLAIN, readLanguage } from "@sp/layout";
import type { ToolResult, ToolSpecBase } from "@sp/engine";
import { LayoutView } from "./layout-view";
import type { LayoutBadge } from "./layout-view";

interface LayoutResultProps {
  result: ToolResult;
  spec: ToolSpecBase;
  input: string;
}

/** C/C++ struct-layout result: the shared layout view with the C platform's badges. */
export function LayoutResult({ result, spec, input }: LayoutResultProps) {
  const data = result.data as LayoutData | undefined;
  const analysis = data?.analysis;
  const display = data?.display ?? null;
  const label = data?.platformLabel;
  const platform = analysis?.platform;

  const badges: LayoutBadge[] = [];
  if (label) {
    badges.push(
      { label: "Architecture", value: label.target },
      { label: "Data model", value: label.dataModel },
      { label: "OS", value: label.os },
    );
  }
  if (display && data?.mode !== "packed") {
    const { packed, pragmaPack } = display.struct;
    const packing = [packed ? "packed (alignment 1)" : "", pragmaPack !== undefined ? `#pragma pack(${pragmaPack})` : ""];
    if (packed || pragmaPack !== undefined) badges.push({ label: "Packing", value: packing.filter(Boolean).join(", ") });
  }
  const align = display?.struct.alignAttribute;
  if (align !== undefined) {
    badges.push({
      label: "Aligned",
      value: typeof align === "number" ? `${align} bytes` : align === "max" ? "target maximum" : `as ${align.ofType}`,
    });
  }

  return (
    <LayoutView
      display={display}
      original={analysis?.result ?? null}
      optimized={analysis?.optimized ?? null}
      mode={data?.mode ?? "natural"}
      compare={spec.options[OPTION_COMPARE] === true}
      explain={spec.options[OPTION_EXPLAIN] === true}
      kind={display?.struct.isUnion ? "union" : "struct"}
      badges={badges}
      optimizedCode={data?.optimizedCode ?? null}
      optimizedSubtitle="Members reordered by alignment, then size. Renamed with an _optimized suffix."
      emptyHint="Enter a valid C/C++ struct or union definition, or fix the errors listed above."
      exportInfo={{
        code: input,
        language: readLanguage(spec.options),
        platform: {
          targetArchitecture: platform?.target ?? "",
          architectureDisplayName: label?.architecture ?? "",
          osType: platform?.os ?? "",
          dataModel: platform?.dataModel ?? "",
        },
        view: data?.mode ?? "natural",
      }}
      exportSubtitle={
        label && platform
          ? `Architecture: ${label.architecture}   Data Model: ${platform.dataModel.toUpperCase()}   OS: ${platform.os}`
          : ""
      }
    />
  );
}
