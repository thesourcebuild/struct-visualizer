import { ImageResponse } from "next/og";
import { SITE_TITLE } from "@/lib/constants";
import { OG_IMAGE } from "@/lib/seo";

// Rendered once at build time and exported as out/og-image.png, a file with a real extension so a
// static host serves it as image/png. Next's opengraph-image convention exports it without one.
export const dynamic = "force-static";

const CELLS = [
  ["#3b82f6", 1],
  ["#d1d5db", 3],
  ["#22c55e", 4],
  ["#a855f7", 1],
  ["#d1d5db", 7],
  ["#f97316", 8],
] as const;

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 80,
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ fontSize: 30, color: "#93c5fd", marginBottom: 16 }}>sizeof · offsetof · alignof</div>
        <div style={{ fontSize: 72, fontWeight: 700, marginBottom: 48 }}>{SITE_TITLE}</div>
        <div style={{ display: "flex", flexWrap: "wrap", width: 16 * 56 }}>
          {CELLS.flatMap(([color, n], i) =>
            Array.from({ length: n }, (_, j) => (
              <div
                key={`${i}-${j}`}
                style={{
                  width: 52,
                  height: 52,
                  margin: 2,
                  borderRadius: 6,
                  background: color,
                  opacity: color === "#d1d5db" ? 0.35 : 1,
                }}
              />
            )),
          )}
        </div>
        <div style={{ fontSize: 28, color: "#cbd5e1", marginTop: 40 }}>
          C/C++, Go, Rust and Zig on x86, x64, ARM, RISC-V, AVR, PIC and 8051
        </div>
      </div>
    ),
    { width: OG_IMAGE.width, height: OG_IMAGE.height },
  );
}
