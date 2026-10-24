import type { SVGProps } from "react";
import type { ToolFamily } from "@sp/engine";

type IconProps = SVGProps<SVGSVGElement>;

function Svg(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    />
  );
}

/** Byte grid: a struct's memory layout. */
export function LayoutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 12h18M9 5v14M15 12v7" />
    </Svg>
  );
}

/** Angle brackets: generated C code. */
export function CodeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />
    </Svg>
  );
}

/** Table: reference data. */
export function TableIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 14.5h18M9.5 9v11" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </Svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  );
}

export function BookIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
      <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5" />
    </Svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 2.5 20h19z" />
      <path d="M12 10v4M12 17.2v.1" />
    </Svg>
  );
}

const TOOL_ICONS: Record<string, (p: IconProps) => React.JSX.Element> = {
  "struct-layout": LayoutIcon,
  "verification-code": CodeIcon,
  "data-models": TableIcon,
  "go-struct-layout": LayoutIcon,
  "go-verification-code": CodeIcon,
  "rust-struct-layout": LayoutIcon,
  "rust-verification-code": CodeIcon,
  "zig-struct-layout": LayoutIcon,
  "zig-verification-code": CodeIcon,
};

export function ToolIcon({ toolId, ...props }: IconProps & { toolId: string }) {
  const Icon = TOOL_ICONS[toolId] ?? LayoutIcon;
  return <Icon {...props} />;
}

/** Per-family accent, used for the sidebar dot and the inactive icon tile. */
export const FAMILY_ACCENT: Record<ToolFamily, { dot: string; tile: string }> = {
  layout: {
    dot: "bg-indigo-500",
    tile: "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300",
  },
  go: {
    dot: "bg-cyan-500",
    tile: "bg-cyan-50 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300",
  },
  rust: {
    dot: "bg-orange-500",
    tile: "bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300",
  },
  zig: {
    dot: "bg-amber-500",
    tile: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
  },
  reference: {
    dot: "bg-emerald-500",
    tile: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
};
