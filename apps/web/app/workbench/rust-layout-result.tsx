"use client";

import type { RustLayoutData } from "@sp/rust-layout/compute";
import { describeDiscriminant, reprLabel } from "@sp/rust-layout/compute";
import { OPTION_COMPARE, OPTION_EXPLAIN } from "@sp/rust-layout";
import type { ToolResult, ToolSpecBase } from "@sp/engine";
import { LayoutView } from "./layout-view";
import type { LayoutBadge } from "./layout-view";

interface RustLayoutResultProps {
  result: ToolResult;
  spec: ToolSpecBase;
  input: string;
}

/** Rust layout result: the shared layout view with the target, repr and enum badges. */
export function RustLayoutResult({ result, spec, input }: RustLayoutResultProps) {
  const data = result.data as RustLayoutData | undefined;
  const a = data?.analysis;
  const def = a?.definition;

  const badges: LayoutBadge[] = [];
  if (a && def) {
    const repr = reprLabel(a);
    const guaranteed = def.repr.c || def.repr.transparent || def.repr.int !== undefined;
    badges.push(
      { label: "Target", value: a.target.label },
      { label: "Layout", value: guaranteed ? repr : `${repr}: chosen by rustc, not guaranteed` },
    );
    const discr = describeDiscriminant(a);
    if (discr) badges.push({ label: "Discriminant", value: discr });
    if (a.optionSize !== null) badges.push({ label: `Option<${def.name}>`, value: `${a.optionSize} bytes` });
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
      optimizedSubtitle="The same repr(C) struct with its fields in the order rustc would choose."
      emptyHint="Enter a Rust struct, enum or union, or fix the errors listed above."
      exportInfo={{
        code: input,
        language: "rust",
        platform: { target: a?.target.id ?? "" },
        view: data?.mode ?? "natural",
      }}
      exportSubtitle={a ? `Rust   Target: ${a.target.id}   ${def ? reprLabel(a) : ""}` : ""}
    />
  );
}
