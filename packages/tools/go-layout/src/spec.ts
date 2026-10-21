import { z } from "zod";
import { OptionValues } from "@sp/contracts";
import { SPEC_VERSION } from "./pure";

export const GoLayoutSpec = z.object({
  specVersion: z.literal(SPEC_VERSION),
  options: OptionValues,
});
export type GoLayoutSpec = z.infer<typeof GoLayoutSpec>;
