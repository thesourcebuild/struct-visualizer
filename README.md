# Struct Visualizer

See byte by byte how a type is laid out in memory: offsets, padding, alignment, and how much a different field order would save. It works for **C/C++**, **Go** and **Rust**, on desktop, mobile and embedded targets, and runs entirely in the browser.

```c
struct Example {
  char a;    // offset 0
             // 3 bytes padding
  int b;     // offset 4
  char c;    // offset 8
             // 7 bytes padding
  double d;  // offset 16
};           // sizeof = 24 on x86-64 Linux (10 bytes padding); 16 if reordered
```

The same struct is 24 bytes in Go, which keeps fields in declaration order, and 16 in Rust, where rustc reorders them unless you write `#[repr(C)]`.

## Languages and tools

Pick a language in the sidebar. Each language has its own editor contents, examples, options and checks.

| Language | Tools | Targets |
|---|---|---|
| **C / C++** | Struct Layout, Verification Code | x86, x86-64, ARM32, ARM64, RISC-V 32/64, Microchip 8/16/32-bit, 8051; 13 data models; Windows/Linux/bare metal |
| **Go** | Go Struct Layout, Go Verification Code | All 14 gc architectures: amd64, arm64, 386, arm, riscv64, loong64, mips(le), mips64(le), ppc64(le), s390x, wasm |
| **Rust** | Rust Type Layout, Rust Verification Code | 13 target triples: x86-64 Linux/Windows/macOS, AArch64 Linux/macOS, i686 Linux/Windows, ARMv7, Cortex-M (thumbv7em), RISC-V 32/64, wasm32, AVR |
| Reference | Data Models | LP64, LLP64, ILP32 and the embedded C compiler models (XC8, XC16, XC32, C51, SDCC) |

Every layout tool shows:

- a byte map, statistics and a member table
- the layout with an optimized field order, side by side with the original
- a step-by-step padding walkthrough with the equations
- an "Across targets" table of the same type on every target
- lint diagnostics, with one-click fixes where there is one
- JSON and PNG export

Each Verification Code tool generates a program that prints the real compiler's sizes and offsets, so any result can be checked on your own toolchain.

### C / C++

A real tokenizer, preprocessor and declarator parser, not pattern matching:

- structs, unions and enums, including `typedef` forms and enums with an underlying type
- typedefs of any type: scalars, pointers, arrays, function pointers
- nested, named-nested and anonymous (C11) struct/union members
- full C declarators: `char *names[4]`, `char (*row)[16]`, function pointers, several names per declaration
- array sizes and bit-field widths as constant expressions, including `#define` and enum constants
- flexible array members (`int data[];`)
- bit-fields placed bit by bit by each compiler's own rules (GCC and Clang, MSVC, SDCC), including unnamed, zero-width, packed and `#pragma pack` ones; the walkthrough shows each field's bit range
- `#pragma pack(n)` with `push`/`pop`, `__attribute__((packed))`, `__attribute__((aligned(n)))`, `alignas` / `_Alignas`, `__declspec(align(n))`, packed enums
- the preprocessor: `#define`, `#if`/`#ifdef`/`#elif`/`#else`, `#include` (skipped; standard types are built in)
- C++: methods, static members, access specifiers, nested types and default member initializers take no space

### Go

Follows the gc compiler's rules (`go/types` `SizesFor("gc", arch)`):

- **Declarations:** structs with embedded fields, nested anonymous structs, struct tags, several names per line, named types and aliases.
- **Generics:** generic types once instantiated (`Pair[string, int64]`).
- **Constants:** `const` blocks with `iota` and Go's operators (`&^`, unary `^`).
- **Sizes:** 64-bit values are 4-byte aligned on 32-bit targets; `string` and interfaces are 2 words, slices 3; a trailing zero-size field adds padding.
- **Standard types:** common ones such as `time.Time`, `sync.Mutex`/`RWMutex`/`WaitGroup`/`Once`, `sync/atomic` (`atomic.Int64` is always 8-aligned), `strings.Builder`, `bytes.Buffer`, `netip.Addr` and `context.Context`.
- **Optimized order:** the order the `fieldalignment` analyzer suggests (least padding, then fewest bytes for the garbage collector to scan), generated as gofmt-formatted code.

### Rust

A port of rustc's layout code (`rustc_abi`):

- **repr(Rust):** structs, tuples and enum variants are reordered the way the current rustc does it, including where the largest niche goes. The language does not guarantee this order, and the tool says so.
- **Other reprs:** `repr(C)`, `repr(transparent)`, `repr(packed(N))`, `repr(align(N))`, `repr(u8)` and the other integer reprs.
- **Enums:** a separate tag (widened to the first field's alignment when that is free), or the discriminant stored in another field's invalid values (niche filling). The layout is chosen exactly as rustc chooses it, so `Option<&T>`, `Option<Box<T>>` and `Option<Vec<T>>` cost nothing, and `Option<Option<bool>>` is one byte.
- **Niches** come from `bool`, `char`, references, `NonNull`, `NonZero*`, fn pointers, enum tags and range-restricted std types (`Vec`'s capacity, `Duration`'s nanoseconds).
- **Standard types** are written in their real std form: `Box`, `Vec`, `String`, `Rc`, `Arc`, `Weak`, `Cell`, `RefCell`, `Option`, `Result`, `Cow`, `Duration`, atomics, `HashMap`/`HashSet`, `BTreeMap`, `VecDeque` and more.
- **Generics:** generic and const-generic types once instantiated; constants with casts, shifts and `size_of::<T>()`; `core::ffi` C types per target.

## How results are checked

The engines are tested against the real compilers, not against expected values written by hand. The tests skip a compiler that is not installed.

| Language | Ground truth (`tests/`) |
|---|---|
| C | `compiler.test.ts` compiles and runs each case with the host's GCC and compares `sizeof`, alignment and every `offsetof` |
| C, every target | `cross-compiler.test.ts` compiles every C example and the bit-field, enum and pointer cases for 14 targets: GCC for x86-64, i386, ARM32 (Linux and arm-none-eabi), AArch64, RISC-V 32/64 (Linux and bare metal), MIPS (PIC32) and AVR; MinGW for x86-64 and i386 Windows (MSVC's bit-field rules); SDCC for the 8051. It reads size, alignment, every `offsetof` and each bit-field's bit position back from the object file, so cross compilers need not run anything |
| Go | `go-compiler.test.ts` checks every case and its reordered version against `go/types` on all 14 architectures, then compiles and runs the generated verification code with `GOARCH=amd64` and `GOARCH=386` |
| Rust | `rust-compiler.test.ts` compiles and runs 71 cases on x86_64-pc-windows-msvc, and checks the same facts as compile-time assertions on thumbv7em-none-eabihf (no_std) |
| All | `cross-language.test.ts` checks that the Go ports and the `repr(C)` Rust ports of the C examples have the C layout |

The cross-compiler test finds its compilers on the PATH, or in WSL on Windows. On Ubuntu:

```bash
sudo apt install --no-install-recommends gcc-i686-linux-gnu gcc-arm-linux-gnueabihf \
  gcc-aarch64-linux-gnu gcc-riscv64-linux-gnu gcc-mipsel-linux-gnu gcc-mingw-w64-x86-64-win32 \
  gcc-mingw-w64-i686-win32 gcc-arm-none-eabi gcc-riscv64-unknown-elf gcc-avr avr-libc sdcc
```

Rust targets whose standard library is not installed locally are modelled from their LLVM data layouts but not compiler-checked. Install one with `rustup target add <triple>` to add it to the test.

## Lint rules

### C / C++ (SP)

| Code | Level | Meaning | Fix |
|---|---|---|---|
| SP000 | error | Parse, preprocessor or type-validation error, with its line | — |
| SP001 | warning | Reordering members would remove padding | Show optimized layout |
| SP003 | error | A type fell back to a guessed 4-byte size | — |
| SP004 | warning | The bit-field positions are not checked against this target's compiler (XC16, Keil C51, bare-metal AArch64) | — |
| SP005 | info | The struct has a different size, offsets or alignment on the target's other OS | Show that OS's layout |
| SP006 | info | A definition is not used by the one shown | — |
| SP008 | warning | Something in the source has no effect here: an ignored `#pragma`, an attribute that is not modelled, a vtable pointer | — |

### Go (GO)

| Code | Level | Meaning | Fix |
|---|---|---|---|
| GO000 | error | Syntax error, with its line | — |
| GO001 | warning / info | Another field order is smaller, or the same size with fewer bytes for the GC to scan (what `fieldalignment` reports) | Show optimized order |
| GO002 | warning | A 64-bit integer is not 8-byte aligned on 32-bit targets, in a file that uses `sync/atomic` | Show the 32-bit layout |
| GO003 | info | A zero-size last field adds padding | — |
| GO004 | error | A type cannot be laid out: unknown, an uninstantiated generic, or recursive | — |
| GO005 | info | A struct type is not used by the one shown | — |
| GO006 | warning | A parser warning, with its line | — |

### Rust (RS)

| Code | Level | Meaning | Fix |
|---|---|---|---|
| RS000 | error | Syntax error, with its line | — |
| RS001 | warning | A `repr(C)` struct would be smaller with its fields reordered | Show optimized order |
| RS003 | info | A packed struct has fields that lose their alignment: borrowing them is error E0793 | — |
| RS004 | error | A type cannot be laid out: unknown, generic, unsized or infinitely recursive | — |
| RS005 | warning | One enum variant is much larger than the others (clippy's `large_enum_variant`) | — |
| RS006 | info | A definition is not used by the one shown | — |
| RS007 | warning | A `cfg` attribute is not evaluated: the field or item is always included | — |

## Workbench

- **Share link:** the whole state goes into the URL `#fragment`, so nothing is uploaded.
- **Saved state:** settings are stored per tool, and editor contents per language, in the browser.
- **Theme:** Light/Dark/System, switching in a single frame.
- **Sidebar:** a language selector, plus search (press `/`).

## Getting started

You need Node.js 22+ and pnpm 12 (`corepack enable` provides it).

```bash
pnpm install
pnpm web            # dev server at http://localhost:3000
pnpm test           # vitest: engines, tools, registry, share links, compiler ground truth
pnpm build          # typecheck + lint + static export to apps/web/out
```

The compiler ground-truth tests use whichever of these are on the PATH: `gcc`, `go` and `rustc`/`rustup`. The full command list is in [docs/scripts.md](docs/scripts.md).

## Architecture

The structure follows [cipherworkbench](https://github.com/thesourcebuild/cipherworkbench): pure TypeScript logic packages implement one tool contract, and a generic workbench builds the UI from each tool's declared options.

```
apps/web/                      Next.js 16 static export: workbench shell, generic panels, content pages
packages/
  config/                      shared tsconfigs
  contracts/      @sp/contracts    zod option schema, Diagnostic/LintRule, PlatformApi
  engine/         @sp/engine       ToolManifest / ToolDefinition contract, option catalogue, lint runner
  core/           @sp/core         layout engines, no DOM:
    src/parser, layout, abi          C parser, ABI tables, padding calculator
    src/go                           Go parser, gc layout, std types, codegen
    src/rust                         Rust lexer/parser, rustc_abi port, std prelude, codegen
  tools/layout    @sp/layout       C/C++ tool family (manifest, spec, catalogue, compute, lint, variants)
  tools/go-layout @sp/go-layout    Go tool family
  tools/rust-layout @sp/rust-layout Rust tool family
  registry/       @sp/registry     TOOL_MANIFESTS (eager) + loadTool(id) (lazy import per family)
  platform/       @sp/platform     host adapter: saved state, file saving (web today)
  ui/             @sp/ui           Panel, Button, CopyButton, Dialog, Overlay, theme tokens
tests/                         vitest, importing packages only through their public entry points
```

The engines all produce the same result shape. A struct, union or enum, in any language, goes through one visualizer, walkthrough, comparison and export path.

## Limitations

These results model compilers; they are not compilers. Not modelled:

- **C++:** inheritance and the vtable pointer of classes with virtual functions; templates (a template has no layout until instantiated).
- **C:** bit-fields on XC16, Keil C51 and bare-metal AArch64 follow GCC's rules without a compiler check (SP004); the 8-bit Microchip target is AVR, not 8-bit PIC; function-like macros (reported, not expanded) and `sizeof` in array sizes; `__attribute__((mode))`, `vector_size` and `ms_struct` (reported when used).
- **Go:** TinyGo (planned); standard-library types beyond the common ones (declare them in the input to lay them out); types from other modules.
- **Rust:**
  - `repr(Rust)` shows what rustc 1.99 does today, which other versions may change.
  - Associated types (`<T as Trait>::Out`), `dyn`/`impl` values, `repr(simd)` and `cfg` attributes (fields under `cfg` are always included).
  - Platform-specific std types such as `Mutex` or `PathBuf`.

Always confirm. See the in-app Limitations page.

---

## Contributions

Contributions of all sizes are warmly welcome! Please feel free to:

- Report issues using [the issue guide](docs/create_a_issue.md)
- Submit pull requests
- Improve documentation
- Suggest new features
- Start a discussion

Let's make the library better for everyone.

---

## License

MIT — see [LICENSE](LICENSE).

## Author

Muhammad Hassaan Shah

- GitHub: [@thesourcebuild](https://github.com/thesourcebuild)
- Project: [github.com/thesourcebuild/struct-visualizer](https://github.com/thesourcebuild/struct-visualizer)
