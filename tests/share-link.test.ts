import { describe, expect, it, vi } from "vitest";
import { layoutToolDefinition } from "@sp/layout/definition";
import type { AnyToolDefinition } from "@sp/engine";
import { MAX_SHARED_INPUT, encodeShareState, parseShareHash } from "../apps/web/app/share-link";
import { restoreSpec } from "../apps/web/app/workbench/restore-spec";
import { readCollapsedFamilies, readSavedInput, readSavedLanguage, readSavedToolId } from "../apps/web/app/workbench/saved-state";
import { THEME_INIT_SCRIPT } from "../apps/web/app/theme-constants";
import { webPlatform } from "../packages/platform/src/web";

const layout = layoutToolDefinition("struct-layout") as unknown as AnyToolDefinition;

describe("share links", () => {
  it("round-trips tool, options and input (including non-ASCII)", () => {
    const state = {
      toolId: "struct-layout",
      options: { target: "arm64", compare: true, size: 4 },
      input: "struct S { char ä; /* ✓ */ int b; };",
    };
    const { hash, inputOmitted } = encodeShareState(state);
    expect(inputOmitted).toBe(false);
    expect(hash).toMatch(/^#s=[A-Za-z0-9_-]+$/);
    expect(parseShareHash(hash)).toEqual(state);
  });

  it("drops oversized input", () => {
    const { hash, inputOmitted } = encodeShareState({
      toolId: "struct-layout",
      options: {},
      input: "x".repeat(MAX_SHARED_INPUT + 1),
    });
    expect(inputOmitted).toBe(true);
    expect(parseShareHash(hash)?.input).toBeUndefined();
  });

  it("rejects malformed fragments", () => {
    expect(parseShareHash("")).toBeUndefined();
    expect(parseShareHash("#s=!!!")).toBeUndefined();
    expect(parseShareHash("#s=e30")).toBeUndefined(); // "{}"
    expect(parseShareHash("#other")).toBeUndefined();
  });

  it("drops non-scalar option values", () => {
    const json = JSON.stringify({ v: 1, t: "struct-layout", o: { ok: "x", bad: { nested: 1 } } });
    const hash = `#s=${Buffer.from(json).toString("base64url")}`;
    expect(parseShareHash(hash)?.options).toEqual({ ok: "x" });
  });

  it("drops a non-finite number and keeps the other options", () => {
    // {"v":1,"t":"struct-layout","o":{"target":"arm64","x":1e400}}: JSON reads 1e400 as Infinity.
    const hash = "#s=eyJ2IjoxLCJ0Ijoic3RydWN0LWxheW91dCIsIm8iOnsidGFyZ2V0IjoiYXJtNjQiLCJ4IjoxZTQwMH19";
    const shared = parseShareHash(hash);
    expect(shared?.options).toEqual({ target: "arm64" });
    const spec = restoreSpec(layout, undefined, shared!.options);
    expect(spec.options.target).toBe("arm64");
    expect(layout.specSchema.safeParse(spec).success).toBe(true);
  });
});

describe("restoring a spec", () => {
  it("applies share-link options over saved ones", () => {
    const spec = restoreSpec(layout, { target: "arm64", mode: "packed" }, { mode: "optimized" });
    expect(spec.options).toMatchObject({ target: "arm64", mode: "optimized" });
  });

  it("drops each saved value no option can hold and keeps the rest", () => {
    // Saved state is JSON from localStorage: anything can be in it.
    const saved = JSON.parse('{"target":"arm64","mode":"packed","x":1e400,"y":null,"z":{"a":1},"w":[1]}');
    const spec = restoreSpec(layout, saved, undefined);
    expect(spec.options).toMatchObject({ target: "arm64", mode: "packed" });
    expect(spec.options).not.toHaveProperty("x");
    expect(spec.options).not.toHaveProperty("y");
    expect(spec.options).not.toHaveProperty("z");
    expect(spec.options).not.toHaveProperty("w");
    expect(layout.specSchema.safeParse(spec).success).toBe(true);
  });

  it("puts an unknown id back to its default and keeps the other options", () => {
    const spec = restoreSpec(layout, undefined, { target: "toString", mode: "packed" });
    expect(spec.options).toMatchObject({ target: "intel-x64-amd", mode: "packed" });
  });

  it("starts from the defaults when saved state is not an object", () => {
    for (const saved of [null, "arm64", 7, ["arm64"]]) {
      expect(restoreSpec(layout, saved, undefined)).toEqual(layout.createSpec());
    }
  });
});

describe("restoring saved browser state", () => {
  // Every value comes back from localStorage as untrusted JSON, and each falls back on its own.
  it("keeps a saved input only when it is a non-empty string", () => {
    expect(readSavedInput("struct S { int x; };")).toBe("struct S { int x; };");
    for (const saved of [undefined, null, "", 7, true, ["struct"], { input: "x" }]) expect(readSavedInput(saved)).toBeUndefined();
  });

  it("keeps the last tool only when it names a tool", () => {
    expect(readSavedToolId("go-struct-layout")).toBe("go-struct-layout");
    for (const saved of [undefined, null, "no-such-tool", "toString", 1, ["struct-layout"]]) expect(readSavedToolId(saved)).toBeUndefined();
  });

  it("keeps the sidebar language only when it is a source language", () => {
    expect(readSavedLanguage("zig")).toBe("zig");
    for (const saved of [undefined, "reference", "cobol", "constructor", 3, ["go"]]) expect(readSavedLanguage(saved)).toBeUndefined();
  });

  it("keeps the known families of a collapsed-sidebar list and drops the rest", () => {
    expect(readCollapsedFamilies(["go", "nope", 3, null, "reference", { f: "zig" }])).toEqual(["go", "reference"]);
    for (const saved of [undefined, null, "go", 1, { 0: "go", length: 1 }]) expect(readCollapsedFamilies(saved)).toEqual([]);
  });

  it("reads stored text that is not JSON as nothing, without throwing", () => {
    const store = new Map<string, string>([
      ["structpadding:lastTool", "go-struct-layout"],
      ["structpadding:sidebar:collapsedFamilies", "[\"go\""],
      ["structpadding:input", JSON.stringify(42)],
    ]);
    const localStorage = { getItem: (k: string) => store.get(k) ?? null };
    vi.stubGlobal("window", { localStorage });
    try {
      // Written by hand (not JSON.stringify): unreadable, so the default is used.
      expect(webPlatform.readSavedState("lastTool")).toBeUndefined();
      expect(readCollapsedFamilies(webPlatform.readSavedState("sidebar:collapsedFamilies"))).toEqual([]);
      expect(readSavedInput(webPlatform.readSavedState("input"))).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("starts the theme script on the system theme when the saved theme is not JSON", () => {
    for (const [saved, systemDark, dark] of [
      ['"dark"', false, true],
      ['"light"', true, false],
      ["dark", true, true],
      ["dark", false, false],
      ["7", true, true],
    ] as const) {
      const classes = new Set<string>();
      const root = { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) } };
      const run = new Function("localStorage", "window", "document", THEME_INIT_SCRIPT);
      run({ getItem: () => saved }, { matchMedia: () => ({ matches: systemDark }) }, { documentElement: root });
      expect(classes.has("dark"), `${saved}, system ${systemDark ? "dark" : "light"}`).toBe(dark);
    }
  });
});
