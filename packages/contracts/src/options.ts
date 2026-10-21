import { z } from "zod";

/** A single option value as stored in a spec. Kept JSON-safe so specs round-trip through share links. */
export const OptionValue = z.union([z.string(), z.number(), z.boolean()]);
export type OptionValue = z.infer<typeof OptionValue>;

export const OptionValues = z.record(z.string(), OptionValue);
export type OptionValues = z.infer<typeof OptionValues>;
