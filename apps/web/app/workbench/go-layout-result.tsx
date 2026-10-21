"use client";

import type { GoLayoutData } from "@sp/go-layout/compute";
import { OPTION_COMPARE, OPTION_EXPLAIN } from "@sp/go-layout";
import type { ToolResult, ToolSpecBase } from "@sp/engine";
import { LayoutView } from "./layout-view";
import type { LayoutBadge } from "./layout-view";

interface GoLayoutResultProps {
  result: ToolResult;
  spec: ToolSpecBase;
  input: string;
}

/** Go struct-layout result: the shared layout view with the Go target's badges. */
export function GoLayoutResult({ result, spec, input }: GoLayoutResultProps) {
  const data = result.data as GoLayoutData | undefined;
  const a = data?.analysis;
  const target = a?.target;

  const badges: LayoutBadge[] = target
    ? [
        { label: "Target", value: target.compiler === "gc" ? `GOARCH=${target.id}` : target.label },
        { label: "Compiler", value: target.compiler === "gc" ? "gc" : "TinyGo" },
        { label: "Word", value: `${target.wordSize * 8}-bit` },
      ]
    : [];

  return (
    <LayoutView
      display={data?.display ?? null}
      original={a?.result ?? null}
      optimized={a?.optimized ?? null}
      mode={data?.mode ?? "natural"}
      compare={spec.options[OPTION_COMPARE] === true}
      explain={spec.options[OPTION_EXPLAIN] === true}
      kind="type"
      badges={badges}
      optimizedCode={data?.optimizedCode ?? null}
      optimizedSubtitle="Fields in the order fieldalignment suggests, added as a copy with an Optimized suffix."
      emptyHint="Enter Go source with a struct type declaration, or fix the errors listed above."
      exportInfo={{
        code: input,
        language: "go",
        platform: { compiler: target?.compiler ?? "", goarch: target?.id ?? "" },
        view: data?.mode ?? "natural",
      }}
      exportSubtitle={target ? `Go ${target.compiler}   Target: ${target.label}   Word: ${target.wordSize * 8}-bit` : ""}
    />
  );
}
