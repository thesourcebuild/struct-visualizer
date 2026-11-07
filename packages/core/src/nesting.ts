/**
 * The deepest nesting the parsers, evaluators and layout engines take, in every language: 256
 * levels, a level being one step of their recursion: a parenthesis, bracket or brace inside
 * another, a nested type or definition, a prefix operator or type operator on its operand (`-`,
 * `*`, `?`, `[N]`), or a declaration worked out inside another (an alias, a constant, a struct laid
 * out inside another). A construct as written is one to three levels.
 *
 * 256 is the minimum the C++ standard recommends every compiler take for nested parentheses,
 * declarators and class definitions (Annex B, [implimits]). The real compilers go further (measured:
 * clang 22 stops at 2048 brackets, its -fbracket-depth default; cl 19.44 takes 1000 parentheses
 * and only 16 nested class definitions, which the C parser applies for MSVC targets; go/parser
 * stops at 100000), so this is the tool's own limit: the engines recurse as the grammar does, and
 * JavaScript's stack is far smaller than a compiler's.
 * Without a limit, Node's default stack overflowed at 340 to 2600 nested constructs, by path;
 * at 256 every path works with half of that stack already in use (tests/nesting.test.ts). Past the
 * limit a parser or engine reports an ordinary error instead of overflowing.
 */
export const MAX_NESTING = 256;

export const NESTING_MESSAGE = `Nested more than ${MAX_NESTING} levels deep, which is more than this tool takes.`;

/**
 * Thrown one level past the limit. It is not any parser's own error class, so no backtracking
 * catch retries it: it unwinds to the parser's entry point, which reports it as a syntax error.
 */
export class NestingError extends Error {
  constructor(readonly line?: number) {
    super(NESTING_MESSAGE);
  }
}

/** A nesting depth, shared by everything one parse runs (the C parser and its constant expressions). */
export class Nesting {
  depth = 0;

  /** Run `f` one level deeper. */
  in<T>(f: () => T, line?: number): T {
    if (this.depth >= MAX_NESTING) throw new NestingError(line);
    this.depth += 1;
    try {
      return f();
    } finally {
      this.depth -= 1;
    }
  }
}
