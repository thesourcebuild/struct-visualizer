import { GoAppShell } from "../../workbench/shell-go";
import { ToolPage, toolMetadata } from "../tool-page";

export const metadata = toolMetadata("go-verification-code");

export default function Page() {
  return <ToolPage id="go-verification-code" Shell={GoAppShell} />;
}
