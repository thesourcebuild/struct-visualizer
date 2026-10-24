import { ZigAppShell } from "../../workbench/shell-zig";
import { ToolPage, toolMetadata } from "../tool-page";

export const metadata = toolMetadata("zig-verification-code");

export default function Page() {
  return <ToolPage id="zig-verification-code" Shell={ZigAppShell} />;
}
