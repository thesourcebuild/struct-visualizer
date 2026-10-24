"use client";

import { AppShell } from "./app-shell";
import type { AppShellProps } from "./app-shell";
import { family } from "./family-zig";
import { ToolFamilyProvider } from "./tool-definitions";

// The workbench for a Zig tool page. Its route imports only this shell, so only this language's
// code is in the page's JavaScript; the other languages load when one of their tools is opened.
export function ZigAppShell(props: AppShellProps) {
  return (
    <ToolFamilyProvider language="zig" module={family}>
      <AppShell {...props} preloadedFamily="zig" />
    </ToolFamilyProvider>
  );
}
