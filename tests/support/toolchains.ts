import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Toolchains the recorded answers (tests/references) come from, where a test picks the toolchain
 * itself. Each version is in a file of its own next to this one, which CI installs from too.
 */

/** The nightly that builds core for the tier-3 Rust targets (-Zbuild-std). */
export const RUST_NIGHTLY = readFileSync(join(__dirname, "rust-nightly"), "utf8").trim();
