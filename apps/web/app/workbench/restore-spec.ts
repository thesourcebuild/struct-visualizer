import type { OptionValues } from "@sp/contracts";
import type { AnyToolDefinition, ToolSpecBase } from "@sp/engine";
import { readOptionValues } from "../share-link";

/**
 * A tool's spec from its saved options (untrusted JSON from localStorage) with share-link options
 * (checked the same way by parseShareHash) on top. Each option falls back on its own: a value no
 * option can hold is left out, and the
 * tool's createSpec replaces ids it does not know with its defaults, so the valid ones all apply.
 */
export function restoreSpec(tool: AnyToolDefinition, saved: unknown, shared: OptionValues | undefined): ToolSpecBase {
  const restored = tool.createSpec({ ...readOptionValues(saved), ...shared });
  return tool.specSchema.safeParse(restored).success ? restored : tool.createSpec();
}
