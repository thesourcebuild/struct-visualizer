"use client";

import { AppShell } from "./app-shell";
import type { AppShellProps } from "./app-shell";
import { family } from "./family-go";
import { ToolFamilyProvider } from "./tool-definitions";

// The workbench for a Go tool page. Its route imports only this shell, so only this language's
// code is in the page's JavaScript; the other languages load when one of their tools is opened.
export function GoAppShell(props: AppShellProps) {
  return (
    <ToolFamilyProvider language="go" module={family}>
      <AppShell {...props} preloadedFamily="go" />
    </ToolFamilyProvider>
  );
}
