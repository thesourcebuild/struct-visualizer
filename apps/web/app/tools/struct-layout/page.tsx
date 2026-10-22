import { LayoutAppShell } from "../../workbench/shell-layout";
import { ToolPage, toolMetadata } from "../tool-page";

export const metadata = toolMetadata("struct-layout");

export default function Page() {
  return <ToolPage id="struct-layout" Shell={LayoutAppShell} />;
}
