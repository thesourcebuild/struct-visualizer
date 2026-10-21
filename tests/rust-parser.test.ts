import { describe, expect, it } from "vitest";
import { analyzeRust, formatRustType, parseRust } from "@sp/core";
import type { RustStruct } from "@sp/core";

const fieldTypes = (code: string, name = "S") =>
  (parseRust(code).items.get(name) as RustStruct).fields.map((f) => formatRustType(f.type));

describe("Rust parser", () => {
  it("parses the type grammar", () => {
    expect(
      fieldTypes(
        "struct S<'a> { a: &'a mut [u8], b: *const dyn Fn(u8) -> u8, c: Vec<Vec<u8>>, d: [u32; 4], e: (u8, (u16,)), f: Option<fn(&str) -> bool>, g: std::collections::HashMap<u32, String>, h: () }",
      ),
    ).toEqual([
      "&mut [u8]",
      "*const dyn Fn(u8) -> u8",
      "Vec<Vec<u8>>",
      "[u32; 4]",
      "(u8, (u16,))",
      "Option<fn(&str) -> bool>",
      "std::collections::HashMap<u32, String>",
      "()",
    ]);
  });

  it("reads repr attributes, generics and ?Sized bounds", () => {
    const file = parseRust(
      "#[derive(Debug)]\n#[repr(C, packed(2))]\npub struct P { a: u8 }\nstruct G<T: ?Sized, const N: usize = 4> { n: [u8; N], t: T }\nstruct W<T> where T: ?Sized { t: T }",
    );
    expect((file.items.get("P") as RustStruct).repr).toEqual({ c: true, transparent: false, packed: 2 });
    const g = file.items.get("G")!;
    expect(g.generics).toEqual([
      { kind: "type", name: "T", default: undefined, maybeUnsized: true },
      expect.objectContaining({ kind: "const", name: "N" }),
    ]);
    expect(file.items.get("W")!.generics[0]).toMatchObject({ maybeUnsized: true });
  });

  it("skips items without layout and flattens inline modules", () => {
    const file = parseRust(`
      use std::fmt;
      macro_rules! m { () => {} }
      impl fmt::Debug for S { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { Ok(()) } }
      trait T { fn x(&self); }
      fn helper() -> u8 { let s = "}"; 1 }
      const NAME: &str = "x";
      mod inner { pub struct In { a: u16 } }
      m!();
      struct S { i: In }
    `);
    expect(file.errors).toEqual([]);
    expect(file.order).toEqual(["In", "S"]);
  });

  it("evaluates constants with casts, shifts and size_of", () => {
    const a = analyzeRust(
      "const A: usize = 1 << 4;\nconst B: u8 = -1i8 as u8;\nconst C: usize = core::mem::size_of::<u64>() * 2;\nstruct S { a: [u8; A], b: [u8; B as usize], c: [u8; C] }",
      "x86_64-unknown-linux-gnu",
    );
    expect(a.errors).toEqual([]);
    // Byte arrays group by their size's alignment: the 16-byte arrays come first.
    expect(a.result!.members.map((m) => [m.member.name, m.offset, m.size])).toEqual([
      ["a", 0, 16],
      ["c", 16, 16],
      ["b", 32, 255],
    ]);
  });

  it("reports what cannot be laid out", () => {
    const err = (code: string) => analyzeRust(code, "x86_64-unknown-linux-gnu").errors[0]?.message ?? "";
    expect(err("struct S { a: Mystery }")).toMatch(/Unknown type 'Mystery'/);
    expect(err("struct S { a: u8, b: [u8] }")).toMatch(/dynamically sized/);
    expect(err("struct S { next: S }")).toMatch(/infinite/);
    expect(err("struct G<T> { t: T }")).toMatch(/generic/);
    expect(err("struct S { a: u8 ")).toMatch(/Expected/);
  });

  it("describes enum encodings", () => {
    const enc = (code: string) => analyzeRust(code, "x86_64-unknown-linux-gnu").enumInfo?.encoding;
    expect(enc("enum E { A(u64), B }")).toBe("tagged");
    expect(enc("enum E { A(Box<u8>), B }")).toBe("niche");
    expect(enc("enum E { A(u32) }")).toBe("single");
    expect(enc("enum E {}")).toBe("empty");
  });
});
