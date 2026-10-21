import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/**
 * A square PNG of public/icon.svg, for the places that want a bitmap: iOS home screens, the web
 * app manifest and the structured-data logo. Rendered at build time by the route handlers that
 * call it, so the PNGs cannot drift from the SVG.
 *
 * The tile is drawn full-bleed on the icon's blue so that iOS, which rounds the corners itself,
 * shows no transparent edge.
 */
export function iconImage(size: number): ImageResponse {
  const svg = readFileSync(join(process.cwd(), "public", "icon.svg"));
  const src = `data:image/svg+xml;base64,${svg.toString("base64")}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#2563eb" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- rendered by satori, not the browser */}
        <img src={src} width={size} height={size} alt="" />
      </div>
    ),
    { width: size, height: size },
  );
}
