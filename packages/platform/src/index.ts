import type { PlatformApi } from "@sp/contracts";
import { webPlatform } from "./web";

/** The active host adapter. Only the web adapter exists today. */
export function platform(): PlatformApi {
  return webPlatform;
}

export type { PlatformApi };
