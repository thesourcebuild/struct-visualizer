import { iconImage } from "@/lib/icon-image";

export const dynamic = "force-static";

export function GET() {
  return iconImage(180);
}
