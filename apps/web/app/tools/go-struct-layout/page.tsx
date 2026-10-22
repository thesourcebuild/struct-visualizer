import { GoAppShell } from "../../workbench/shell-go";
import { ToolPage, toolMetadata } from "../tool-page";

export const metadata = toolMetadata("go-struct-layout");

export default function Page() {
  return <ToolPage id="go-struct-layout" Shell={GoAppShell} />;
}
