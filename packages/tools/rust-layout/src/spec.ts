import { z } from "zod";
import { OptionValues } from "@sp/contracts";
import { SPEC_VERSION } from "./pure";

export const RustLayoutSpec = z.object({
  specVersion: z.literal(SPEC_VERSION),
  options: OptionValues,
});
export type RustLayoutSpec = z.infer<typeof RustLayoutSpec>;
