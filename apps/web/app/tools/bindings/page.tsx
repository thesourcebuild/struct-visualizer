import { LayoutAppShell } from "../../workbench/shell-layout";
import { ToolPage, toolMetadata } from "../tool-page";

export const metadata = toolMetadata("bindings");

export default function Page() {
  return <ToolPage id="bindings" Shell={LayoutAppShell} />;
}
