import { describe, expect, it } from "vitest";
import { analyzeGo, analyzeRust, analyzeStruct, analyzeZig, examples, goExamples, rustExamples, zigExamples } from "@sp/core";

/**
 * The Go, Rust and Zig examples include the C examples written in those languages. Where the
 * languages promise the same layout, they must agree with the C engine (itself checked against
 * GCC): Go keeps declaration order like C, and Rust's repr(C) and Zig's extern are C's layout.
 */
const LP64 = { target: "intel-x64-amd", dataModel: "LP64", os: "linux" } as const;
const cByName = new Map(examples.map((e) => [e.name, e.code]));

/** Go ports that replace a C feature Go lacks are not the same layout. */
const NOT_EQUIVALENT = new Set(["Bit Flags (instead of bit-fields)"]);

type Result = NonNullable<ReturnType<typeof analyzeStruct>["result"]>;

/** Where each member is: its byte offset, or a bit-field's first bit and width, from the start. */
function positions(r: Result, base = 0): string[] {
  return r.members.flatMap((m) => {
    if (m.bitOffset !== undefined) return [`bits ${base * 8 + m.bitOffset}+${m.member.bitField}`];
    // A packed struct member: its fields are the bit-fields.
    if (m.nested && !m.nested.struct.isUnion && m.nested.members.some((x) => x.bitOffset !== undefined)) return positions(m.nested, base + m.offset);
    return [`byte ${base + m.offset}`];
  });
}

describe("C examples ported to Go, Rust and Zig", () => {
  const goPorts = goExamples.filter((e) => cByName.has(e.name));
  const rustPorts = rustExamples.filter((e) => cByName.has(e.name));

  it("cover every C example Go can express, and all of them in Rust", () => {
    expect(goPorts.map((e) => e.name)).toEqual([
      "Basic Struct",
      "Optimized Struct",
      "Nested Struct",
      "Array Members",
      "Pointer Members",
      "Advanced Pointers (Double + Function)",
      "Enum Members",
      "Typedef Enum Members",
    ]);
    // Every C example except bit-fields, which have a separate flags example.
    expect(rustPorts.length).toBe(examples.filter((e) => e.language === "c").length - 1);
  });

  for (const port of goPorts) {
    it(`Go: ${port.name} has the C layout on amd64`, () => {
      const c = analyzeStruct(cByName.get(port.name)!, LP64).result!;
      const go = analyzeGo(port.code, "amd64").result!;
      expect({ size: go.totalSize, align: go.struct.alignment, offsets: go.members.map((m) => m.offset) }).toEqual({
        size: c.totalSize,
        align: c.struct.alignment,
        offsets: c.members.map((m) => m.offset),
      });
    });
  }

  it("cover every C example in Zig", () => {
    expect(zigExamples.filter((e) => cByName.has(e.name)).length).toBe(examples.filter((e) => e.language === "c").length);
  });

  // Zig's extern containers are C's layout, member for member; packed bit-fields included, as
  // packed struct(u16) holds the bits where GCC puts them.
  for (const port of zigExamples.filter((e) => cByName.has(e.name))) {
    const a = analyzeZig(port.code, "x86_64-linux-gnu");
    if (a.definition?.layout !== "extern") continue;
    it(`Zig: ${port.name} (extern) has the C layout on x86-64 Linux`, () => {
      const c = analyzeStruct(cByName.get(port.name)!, LP64).result!;
      expect({ size: a.result!.totalSize, align: a.result!.struct.alignment, at: positions(a.result!) }).toEqual({
        size: c.totalSize,
        align: c.struct.alignment,
        at: positions(c),
      });
    });
  }

  for (const port of rustPorts.filter((e) => !NOT_EQUIVALENT.has(e.name))) {
    const a = analyzeRust(port.code, "x86_64-unknown-linux-gnu");
    if (!a.definition?.repr.c) continue;
    it(`Rust: ${port.name} (repr(C)) has the C layout on x86-64 Linux`, () => {
      const c = analyzeStruct(cByName.get(port.name)!, LP64).result!;
      expect({ size: a.result!.totalSize, align: a.result!.struct.alignment }).toEqual({
        size: c.totalSize,
        align: c.struct.alignment,
      });
    });
  }
});
