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

describe("Rust line ends", () => {
  // rustc 1.99 (measured): a carriage return without a line feed is white space, so a line comment
  // runs on past it; in a doc comment or a literal it is an error.
  it("reads a bare carriage return as a space, and rejects one in a doc comment or a literal", () => {
    expect(parseRust("// note\rstruct X { a: u8 }\nstruct S { a: u8,\rb: u32 }").items.has("X")).toBe(false);
    expect(analyzeRust("#[repr(C)] struct S { a: u8,\rb: u32 }", "x86_64-unknown-linux-gnu").result?.totalSize).toBe(8);
    expect(parseRust("/// doc\r\nstruct S { a: u8 }").errors).toEqual([]);
    const error = (code: string) => parseRust(code).errors[0]?.message;
    expect(error("/// doc\rstruct S { a: u8 }")).toBe("Bare CR not allowed in doc-comment.");
    expect(error("//! doc\rx\nstruct S { a: u8 }")).toBe("Bare CR not allowed in doc-comment.");
    expect(error("//// not a doc comment\rx\nstruct S { a: u8 }")).toBeUndefined();
    expect(error("/** doc\r */\nstruct S { a: u8 }")).toBe("Bare CR not allowed in block doc-comment.");
    expect(error("/* plain\r */\nstruct S { a: u8 }")).toBeUndefined();
    expect(error("const X: &str = \"a\rb\";\nstruct S { a: u8 }")).toBe("Bare CR not allowed in string, use `\\r` instead.");
    expect(error("const X: &str = r\"a\rb\";\nstruct S { a: u8 }")).toBe("Bare CR not allowed in raw string.");
    expect(error("const X: u8 = b'\r';\nstruct S { a: u8 }")).toBe("Character constant must be escaped: `\\r`.");
  });
});
