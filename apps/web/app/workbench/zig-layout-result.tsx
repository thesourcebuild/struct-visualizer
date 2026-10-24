"use client";

import type { ZigLayoutData } from "@sp/zig-layout/compute";
import { describeUnionTag, layoutGuaranteed, layoutLabel } from "@sp/zig-layout/compute";
import { OPTION_COMPARE, OPTION_EXPLAIN } from "@sp/zig-layout";
import type { ToolResult, ToolSpecBase } from "@sp/engine";
import { LayoutView } from "./layout-view";
import type { LayoutBadge } from "./layout-view";

interface ZigLayoutResultProps {
  result: ToolResult;
  spec: ToolSpecBase;
  input: string;
}

/** Zig layout result: the shared layout view with the target, layout kind and tag badges. */
export function ZigLayoutResult({ result, spec, input }: ZigLayoutResultProps) {
  const data = result.data as ZigLayoutData | undefined;
  const a = data?.analysis;
  const def = a?.definition;

  const badges: LayoutBadge[] = [];
  if (a && def) {
    const label = layoutLabel(a);
    badges.push(
      { label: "Target", value: `${a.target.label}${a.target.arch === "x86_64" ? ` (${a.cpu.label})` : ""}, ${a.mode}` },
      { label: "Layout", value: layoutGuaranteed(a) ? label : `${label}: order chosen by the compiler, not guaranteed` },
    );
    const tag = describeUnionTag(a);
    if (tag) badges.push({ label: "Tag", value: tag });
    if (a.packedBacking) badges.push({ label: "Backing integer", value: a.packedBacking });
    if (a.optionalSize !== null) badges.push({ label: `?${def.name}`, value: `${a.optionalSize} bytes` });
  }

  return (
    <LayoutView
      display={data?.display ?? null}
      original={a?.result ?? null}
      optimized={a?.optimized ?? null}
      mode={data?.mode ?? "natural"}
      compare={spec.options[OPTION_COMPARE] === true}
      explain={spec.options[OPTION_EXPLAIN] === true}
      kind={def?.kind ?? "struct"}
      badges={badges}
      optimizedCode={data?.optimizedCode ?? null}
      optimizedSubtitle="The same extern struct with its fields in the order Zig gives a plain struct."
      emptyHint="Enter a Zig struct, union or enum, or fix the errors listed above."
      exportInfo={{
        code: input,
        language: "zig",
        platform: { target: a?.target.id ?? "", mode: a?.mode ?? "" },
        view: data?.mode ?? "natural",
      }}
      exportSubtitle={a ? `Zig   Target: ${a.target.id}   ${a.mode}   ${def ? layoutLabel(a) : ""}` : ""}
    />
  );
}
