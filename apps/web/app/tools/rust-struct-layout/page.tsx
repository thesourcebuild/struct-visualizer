import { RustAppShell } from "../../workbench/shell-rust";
import { ToolPage, toolMetadata } from "../tool-page";

export const metadata = toolMetadata("rust-struct-layout");

export default function Page() {
  return <ToolPage id="rust-struct-layout" Shell={RustAppShell} />;
}
