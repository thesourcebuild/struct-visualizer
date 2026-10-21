import { pageMetadata } from "@/lib/seo";
import { AppShell } from "../workbench/app-shell";

export const metadata = pageMetadata({
  path: "/tools/",
  title: "C/C++, Go and Rust Memory Layout Workbench",
  description:
    "Analyze C/C++, Go and Rust type layout, padding and alignment across x86, x64, ARM, RISC-V, WebAssembly and embedded targets, in your browser.",
  keywords: [
    "struct padding calculator",
    "memory layout",
    "struct visualization",
    "alignment calculator",
    "C struct tool",
    "C++ struct analyzer",
    "Go struct alignment",
    "Rust type layout",
  ],
});

/** /tools/ — opens the last-used tool (or the default). Per-tool URLs live at /tools/<id>/. */
export default function ToolsPage() {
  return <AppShell />;
}
