import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_ID, TOOL_MANIFESTS, getManifest, loadTool, presentFamilies } from "@sp/registry";

describe("registry", () => {
  it("has unique tool ids", () => {
    const ids = TOOL_MANIFESTS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has a default tool", () => {
    expect(getManifest(DEFAULT_TOOL_ID)).toBeDefined();
  });

  it("fills every required manifest field", () => {
    for (const m of TOOL_MANIFESTS) {
      expect(m.id, m.id).toMatch(/^[a-z0-9-]+$/);
      expect(m.label.length, m.id).toBeGreaterThan(0);
      expect(m.summary.length, m.id).toBeGreaterThan(20);
      expect(m.category.length, m.id).toBeGreaterThan(0);
      expect(presentFamilies()).toContain(m.family);
    }
  });

  it("rejects unknown ids", async () => {
    await expect(loadTool("no-such-tool")).rejects.toThrow(/Unknown tool id/);
  });

  for (const manifest of TOOL_MANIFESTS) {
    it(`${manifest.id}: loads, matches its manifest and computes every sample`, async () => {
      const tool = await loadTool(manifest.id);
      expect(tool.id).toBe(manifest.id);
      expect(tool.family).toBe(manifest.family);
      expect(tool.readsInput).toBe(manifest.readsInput);
      expect(Boolean(tool.variants)).toBe(manifest.supportsVariants);

      const spec = tool.createSpec();
      expect(tool.specSchema.safeParse(spec).success).toBe(true);
      expect(tool.describe(spec).length).toBeGreaterThan(0);

      // Every catalogue option has a value in the default spec.
      for (const def of tool.catalogue.all) {
        expect(spec.options[def.id], `${manifest.id}.${def.id}`).toBeDefined();
      }

      const samples = tool.samples ?? [{ id: "empty", label: "empty", input: "" }];
      for (const sample of samples) {
        // A sample comes with the options it needs (a C++ example selects C++).
        const result = tool.compute(sample.options ? tool.createSpec({ ...spec.options, ...sample.options }) : spec, sample.input);
        expect(result.error, `${manifest.id}/${sample.id}`).toBeUndefined();
      }
    });
  }
});
