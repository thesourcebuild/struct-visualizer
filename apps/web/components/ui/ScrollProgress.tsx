"use client";

import React, { useEffect, useState } from "react";

export default function ScrollProgress({ height = 3 }: { height?: number }) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    function update() {
      const scrollY = window.scrollY || window.pageYOffset;
      const docH = document.documentElement.scrollHeight || 0;
      const winH = window.innerHeight || document.documentElement.clientHeight || 0;
      const denom = Math.max(docH - winH, 1);
      const p = Math.min(1, Math.max(0, scrollY / denom));
      setProgress(p);
    }

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    // A thin accent line on the header's bottom edge; no grey track, which read as a second border.
    <div style={{ height }} className="absolute left-0 right-0 -bottom-px pointer-events-none" aria-hidden>
      <div
        className="h-full bg-blue-600 dark:bg-blue-400 transition-[width] duration-150"
        style={{ width: `${Math.round(progress * 100)}%` }}
      />
    </div>
  );
}
