import { LayoutAppShell } from "../../workbench/shell-layout";
import { ToolPage, toolMetadata } from "../tool-page";

export const metadata = toolMetadata("verification-code");

export default function Page() {
  return <ToolPage id="verification-code" Shell={LayoutAppShell} />;
}
