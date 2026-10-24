import { z } from "zod";
import { OptionValues } from "@sp/contracts";
import { SPEC_VERSION } from "./pure";

export const ZigLayoutSpec = z.object({
  specVersion: z.literal(SPEC_VERSION),
  options: OptionValues,
});
export type ZigLayoutSpec = z.infer<typeof ZigLayoutSpec>;
