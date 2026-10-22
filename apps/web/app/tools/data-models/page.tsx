import { LayoutAppShell } from "../../workbench/shell-layout";
import { ToolPage, toolMetadata } from "../tool-page";

export const metadata = toolMetadata("data-models");

export default function Page() {
  return <ToolPage id="data-models" Shell={LayoutAppShell} />;
}
