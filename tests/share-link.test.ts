import { describe, expect, it } from "vitest";
import { MAX_SHARED_INPUT, encodeShareState, parseShareHash } from "../apps/web/app/share-link";

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
});
