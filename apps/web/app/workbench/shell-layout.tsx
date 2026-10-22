"use client";

import { AppShell } from "./app-shell";
import type { AppShellProps } from "./app-shell";
import { family } from "./family-layout";
import { ToolFamilyProvider } from "./tool-definitions";

// The workbench for a C/C++ (and the reference tools) tool page. Its route imports only this shell, so only this language's
// code is in the page's JavaScript; the other languages load when one of their tools is opened.
export function LayoutAppShell(props: AppShellProps) {
  return (
    <ToolFamilyProvider language="layout" module={family}>
      <AppShell {...props} preloadedFamily="layout" />
    </ToolFamilyProvider>
  );
}
