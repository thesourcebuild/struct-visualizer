import { pageMetadata } from "@/lib/seo";
import { LayoutAppShell } from "../workbench/shell-layout";

export const metadata = pageMetadata({
  path: "/tools/",
  title: "C/C++, Go, Rust and Zig Memory Layout Workbench",
  description:
    "Analyze C/C++, Go, Rust and Zig type layout, padding and alignment across x86, x64, ARM, RISC-V, WebAssembly and embedded targets, in your browser.",
  keywords: [
    "struct padding calculator",
    "memory layout",
    "struct visualization",
    "alignment calculator",
    "C struct tool",
    "C++ struct analyzer",
    "Go struct alignment",
    "Rust type layout",
    "Zig struct layout",
  ],
});

/**
 * /tools/ — opens the last-used tool (or the default, a C/C++ tool, whose language is the one
 * loaded up front). Per-tool URLs live at /tools/<id>/.
 */
export default function ToolsPage() {
  return <LayoutAppShell />;
}
