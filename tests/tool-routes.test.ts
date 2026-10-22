import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_MANIFESTS } from "@sp/registry";

/**
 * Each tool has its own route file, app/tools/<id>/page.tsx, so that Next.js bundles only that
 * tool's language into the page (one dynamic [tool] route bundled every language into every tool
 * page). The cost is that a new tool needs a route file; this checks none is missing or wrong.
 */
const TOOLS_DIR = join(__dirname, "../apps/web/app/tools");
const shellFor = (family: string) => (family === "reference" ? "layout" : family);

describe("tool routes", () => {
  for (const m of TOOL_MANIFESTS) {
    it(`${m.id} has a route with its own language's shell`, () => {
      const file = join(TOOLS_DIR, m.id, "page.tsx");
      expect(existsSync(file), `missing ${file}`).toBe(true);
      const source = readFileSync(file, "utf8");
      expect(source).toContain(`toolMetadata("${m.id}")`);
      expect(source).toContain(`id="${m.id}"`);
      expect(source).toContain(`"../../workbench/shell-${shellFor(m.family)}"`);
      // Importing another language's shell would put its code back into this page.
      for (const other of ["layout", "go", "rust"].filter((f) => f !== shellFor(m.family))) {
        expect(source).not.toContain(`shell-${other}`);
      }
    });
  }

  it("has no route for a tool that is not registered", () => {
    const ids = new Set(TOOL_MANIFESTS.map((m) => m.id));
    const routes = readdirSync(TOOLS_DIR).filter((d) => statSync(join(TOOLS_DIR, d)).isDirectory());
    expect(routes.filter((d) => !ids.has(d))).toEqual([]);
  });
});
