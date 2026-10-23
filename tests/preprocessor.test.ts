import { describe, expect, it } from "vitest";
import type { ParseError } from "@sp/core";
import { expandMacros, preprocess } from "../packages/core/src/parser/preprocess";
import { tokenize } from "../packages/core/src/parser/tokens";

/**
 * Macro expansion against the examples in C11 6.10.3.5 and 6.10.3.3, which give the exact result
 * of each. Results are compared token by token: the standard leaves the spacing between tokens
 * open, except inside stringized arguments, which are string tokens here.
 */
function expand(source: string): string {
  const pre = preprocess(source);
  const errors: ParseError[] = [];
  const out = expandMacros(tokenize(pre.text), pre.macros, errors);
  expect([...pre.errors, ...errors]).toEqual([]);
  return out.map((t) => t.value).join(" ");
}
const spelled = (code: string) => tokenize(code).map((t) => t.value).join(" ");

describe("macro expansion (C11 6.10.3)", () => {
  it("rescans and hides macros as in 6.10.3.5 EXAMPLE 3", () => {
    const source = [
      "#define x 3",
      "#define f(a) f(x * (a))",
      "#undef x",
      "#define x 2",
      "#define g f",
      "#define z z[0]",
      "#define h g(~",
      "#define m(a) a(w)",
      "#define w 0,1",
      "#define t(a) a",
      "#define p() int",
      "#define q(x) x",
      "#define r(x,y) x ## y",
      "#define str(x) # x",
      "f(y+1) + f(f(z)) % t(t(g)(0) + t)(1);",
      "g(x+(3,4)-w) | h 5) & m",
      "(f)^m(m);",
      "p() i[q()] = { q(1), r(2,3), r(4,), r(,5), r(,) };",
      "char c[2][6] = { str(hello), str() };",
    ].join("\n");
    expect(expand(source)).toBe(
      spelled(
        [
          "f(2 * (y+1)) + f(2 * (f(2 * (z[0])))) % f(2 * (0)) + t(1);",
          "f(2 * (2+(3,4)-0,1)) | f(2 * (~ 5)) & f(2 * (0,1))^m(0,1);",
          "int i[] = { 1, 23, 4, 5, };",
          'char c[2][6] = { "hello", "" };',
        ].join("\n"),
      ),
    );
  });

  it("stringizes and pastes as in 6.10.3.5 EXAMPLE 4", () => {
    const source = [
      "#define str(s) # s",
      "#define xstr(s) str(s)",
      '#define debug(s, t) printf("x" # s "= %d, x" # t "= %s", \\',
      "  x ## s, x ## t)",
      "#define INCFILE(n) vers ## n",
      "#define glue(a, b) a ## b",
      "#define xglue(a, b) glue(a, b)",
      '#define HIGHLOW "hello"',
      '#define LOW LOW ", world"',
      "debug(1, 2);",
      "fputs(str(strncmp(\"abc\\0d\", \"abc\", '\\4') // this goes away",
      "  == 0) str(: @\\n), s);",
      "xstr(INCFILE(2).h)",
      "glue(HIGH, LOW);",
      "xglue(HIGH, LOW)",
    ].join("\n");
    expect(expand(source)).toBe(
      [
        spelled('printf("x" "1" "= %d, x" "2" "= %s", x1, x2);'),
        spelled('fputs("strncmp(\\"abc\\\\0d\\", \\"abc\\", \'\\\\4\') == 0" ": @\\n", s);'),
        spelled('"vers2.h"'),
        spelled('"hello";'),
        spelled('"hello" ", world"'),
      ].join(" "),
    );
  });

  it("handles empty arguments to ## as in 6.10.3.5 EXAMPLE 5", () => {
    const source = "#define t(x,y,z) x ## y ## z\nint j[] = { t(1,2,3), t(,4,5), t(6,,7), t(8,9,),\nt(10,,), t(,11,), t(,,12), t(,,) };";
    expect(expand(source)).toBe(spelled("int j[] = { 123, 45, 67, 89, 10, 11, 12, };"));
  });

  it("expands variable arguments as in 6.10.3.5 EXAMPLE 7", () => {
    const source = [
      "#define debug(...) fprintf(stderr, __VA_ARGS__)",
      "#define showlist(...) puts(#__VA_ARGS__)",
      "#define report(test, ...) ((test)?puts(#test):\\",
      "  printf(__VA_ARGS__))",
      'debug("Flag");',
      'debug("X = %d\\n", x);',
      "showlist(The first, second, and third items.);",
      'report(x>y, "x is %d but y is %d", x, y);',
    ].join("\n");
    expect(expand(source)).toBe(
      spelled(
        [
          'fprintf(stderr, "Flag");',
          'fprintf(stderr, "X = %d\\n", x);',
          'puts("The first, second, and third items.");',
          '((x>y)?puts("x>y"): printf("x is %d but y is %d", x, y));',
        ].join("\n"),
      ),
    );
  });

  it("keeps a pasted ## as an ordinary token, as in 6.10.3.3 EXAMPLE", () => {
    const source = [
      "#define hash_hash # ## #",
      "#define mkstr(a) # a",
      "#define in_between(a) mkstr(a)",
      "#define join(c, d) in_between(c hash_hash d)",
      "char p[] = join(x, y);",
    ].join("\n");
    expect(expand(source)).toBe(spelled('char p[] = "x ## y";'));
  });

  it("supports __VA_OPT__ and GNU's comma before an empty __VA_ARGS__", () => {
    const source = [
      "#define F(a, ...) f(a __VA_OPT__(,) __VA_ARGS__)",
      "#define G(fmt, ...) g(fmt, ## __VA_ARGS__)",
      "#define H(fmt, args...) h(fmt, ## args)",
      "F(1) F(1, 2, 3) G(x) G(x, y) H(z) H(z, w)",
    ].join("\n");
    expect(expand(source)).toBe(spelled("f(1) f(1, 2, 3) g(x) g(x, y) h(z) h(z, w)"));
  });

  it("leaves a function-like macro name without '(' alone", () => {
    expect(expand("#define f(x) x\nint f; f(1)")).toBe(spelled("int f; 1"));
  });

  it("gives __LINE__ the line of the invocation", () => {
    expect(expand("#define CAT(a, b) a ## b\n#define PAD(n) CAT(pad, n)\n\nPAD(__LINE__)")).toBe("pad4");
  });

  it("evaluates function-like macros in #if", () => {
    expect(expand("#define VER(a, b) ((a) * 100 + (b))\n#if VER(2, 3) > 201\nyes\n#else\nno\n#endif")).toBe("yes");
  });

  it("reports pasting that does not make one token", () => {
    const pre = preprocess("#define P(a, b) a ## b\nP(x, +)");
    const errors: ParseError[] = [];
    expandMacros(tokenize(pre.text), pre.macros, errors);
    expect(errors.map((e) => e.message)).toEqual(["Pasting 'x' and '+' does not give a valid token."]);
  });

  it("rejects '#' not followed by a parameter, and '##' at either end", () => {
    expect(preprocess("#define S(a) # b").errors[0]?.message).toMatch(/'#' in macro 'S' must be followed by a parameter/);
    expect(preprocess("#define P(a) ## a").errors[0]?.message).toMatch(/'##' cannot be at either end of macro 'P'/);
    expect(preprocess("#define Q a ##").errors[0]?.message).toMatch(/'##' cannot be at either end of macro 'Q'/);
  });
});
