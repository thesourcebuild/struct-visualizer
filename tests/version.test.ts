import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const VERSION = readFileSync(join(ROOT, "version"), "utf8").trim();

function packageJsonPaths(): string[] {
  const out = [join(ROOT, "package.json")];
  for (const dir of ["apps", "packages", "packages/tools"]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      const p = join(ROOT, dir, name, "package.json");
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

describe("version", () => {
  it("is semver", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const p of packageJsonPaths()) {
    it(`${p.slice(ROOT.length + 1)} matches the version file`, () => {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      expect(pkg.version).toBe(VERSION);
    });
  }
});
