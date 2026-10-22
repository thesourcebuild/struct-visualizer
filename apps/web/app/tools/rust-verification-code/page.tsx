import { RustAppShell } from "../../workbench/shell-rust";
import { ToolPage, toolMetadata } from "../tool-page";

export const metadata = toolMetadata("rust-verification-code");

export default function Page() {
  return <ToolPage id="rust-verification-code" Shell={RustAppShell} />;
}
