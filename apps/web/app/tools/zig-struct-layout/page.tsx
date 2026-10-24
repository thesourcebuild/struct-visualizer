import { ZigAppShell } from "../../workbench/shell-zig";
import { ToolPage, toolMetadata } from "../tool-page";

export const metadata = toolMetadata("zig-struct-layout");

export default function Page() {
  return <ToolPage id="zig-struct-layout" Shell={ZigAppShell} />;
}
