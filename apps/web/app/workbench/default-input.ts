import type { InputLanguage } from "@sp/engine";

// Inlined (not imported from @sp/core) so the shell's eager bundle stays free of the engine.
export const DEFAULT_INPUTS: Record<InputLanguage, string> = {
  c: `struct Example {
  char a;
  int b;
  char c;
  double d;
};`,
  go: `package main

type Example struct {
	a byte
	b int32
	c byte
	d float64
}`,
  rust: `struct Example {
    a: u8,
    b: i32,
    c: u8,
    d: f64,
}`,
};

/** Editor wording per input language. */
export const INPUT_COPY: Record<InputLanguage, { title: string; subtitle: string; placeholder: string }> = {
  c: {
    title: "Struct definition",
    subtitle: "C/C++ struct, union and enum definitions. The last definition is laid out.",
    placeholder: "Enter your C/C++ struct definition here...",
  },
  go: {
    title: "Go source",
    subtitle: "Type declarations, constants and imports. The last struct type is laid out.",
    placeholder: "type Example struct { ... }",
  },
  rust: {
    title: "Rust source",
    subtitle: "Struct, union and enum definitions. The last definition is laid out.",
    placeholder: "struct Example { ... }",
  },
};
