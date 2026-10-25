# Struct Visualizer

See byte by byte how a type is laid out in memory: offsets, padding, alignment, and how much a different field order would save. It works for **C/C++**, **Go**, **Rust** and **Zig**, on desktop, mobile and embedded targets, and runs entirely in the browser.

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

The same struct is 24 bytes in Go, which keeps fields in declaration order, and 16 in Rust and Zig, whose compilers reorder them unless you write `#[repr(C)]` or `extern struct`.

## Languages and tools

Pick a language in the sidebar. Each language has its own editor contents, examples, options and checks.

| Language | Tools | Targets |
|---|---|---|
| **C / C++** | Struct Layout, Verification Code, Bindings | x86, x86-64, ARM32, ARM64, RISC-V 32/64, PowerPC 32 and MIPS32 (big-endian), Microchip 8/16/32-bit, 8051; 13 data models; Windows/Linux/bare metal |
| **Go** | Go Struct Layout, Go Verification Code | All 14 gc architectures: amd64, arm64, 386, arm, riscv64, loong64, mips(le), mips64(le), ppc64(le), s390x, wasm |
| **Rust** | Rust Type Layout, Rust Verification Code | 13 target triples: x86-64 Linux/Windows/macOS, AArch64 Linux/macOS, i686 Linux/Windows, ARMv7, Cortex-M (thumbv7em), RISC-V 32/64, wasm32, AVR |
| **Zig** | Zig Type Layout, Zig Verification Code | 16 targets: x86-64 Linux/Windows (GNU and MSVC)/macOS, AArch64 Linux/macOS, x86 Linux/Windows, ARMv7, Cortex-M4, RISC-V 32/64, wasm32, AVR, big-endian PowerPC 32 and MIPS32; each in Debug, ReleaseSafe, ReleaseFast or ReleaseSmall, on x86-64 for each CPU level (`-mcpu`), and for any `--error-limit` |
| Reference | Data Models | All 13: LP32, ILP32, ILP32LL, ILP32LL64, LP64, LLP64, ILP64, SILP64 and the embedded C compiler models (XC8, XC16, XC32, C51, SDCC) |

Every layout tool shows:

- a byte map, statistics and a member table
- the layout with an optimized field order, side by side with the original (in Rust and Zig, whose compilers already order fields, for `repr(C)` and `extern struct`)
- a step-by-step padding walkthrough with the equations
- an "Across targets" table of the same type on every target
- lint diagnostics, with one-click fixes where there is one
- JSON and PNG export

Each Verification Code tool generates a program that prints the real compiler's sizes and offsets, so any result can be checked on your own toolchain.

The **Bindings** tool writes a C struct in another language with exactly its size and member offsets on the selected target:

- **Rust** (`#[repr(C)]`, `packed(n)`, `align(n)`, unions) and **Zig** (`extern struct` with each field's C alignment) follow the target's C ABI, so they name the target triple to compile for.
- **Go** has every padding byte as a `_ [n]byte` field and exported field names, so `encoding/binary` reads and writes it as the target stores it, for the GOARCH named in the file. Pointers are integers of the target's pointer size; a target Go has no port for is an error, not a guess.
- **C#** (`LayoutKind.Explicit` with every `FieldOffset`), **Python `struct`** (the target's byte order with pad bytes) and **Python `ctypes`** (packed, padding written out, target byte order) have the same offsets on any machine, so they also serve to read the target's raw data. C# cannot declare a byte order, so for a big-endian target the result says to reverse the multi-byte fields.
- Bit-fields become the bytes they share, with each field's bit range in a comment; what a language cannot carry (a union in Go, a flexible array member in C#) is said in the result.
- Every binding checks its own layout where the language can: at compile time in Rust (`offset_of!`), Zig (`@offsetOf`) and Go (`unsafe.Offsetof`), so a build for another target fails, and on import in Python. It reads and writes the target's bytes (`from_bytes` in Rust, `std.mem.bytesToValue` in Zig, `ReadX`/`WriteX` in Go, `FromBytes`/`ToBytes` in C#, `pack`/`unpack` and `from_buffer_copy` in Python), and runs as a program that makes a round trip through those bytes, the way its language runs a file: `rustc Example.rs`, `zig run Example.zig`, `go test` (with its example test file), `dotnet run` (with its example program file), `python Example.py`; in Rust and Zig the same round trip is also a test. A bare-metal target, with no machine to run it on, gets neither. The result says how to build it, use it and run it.

### C / C++

A real tokenizer, preprocessor and declarator parser, not pattern matching:

- structs, unions and enums, including `typedef` forms and enums with an underlying type
- typedefs of any type: scalars, pointers, arrays, function pointers
- nested, named-nested and anonymous (C11) struct/union members
- full C declarators: `char *names[4]`, `char (*row)[16]`, function pointers, several names per declaration
- array sizes, bit-field widths and enum values as constant expressions, including macros, enum constants, casts, and `sizeof`, `_Alignof`, `__alignof__` and `offsetof` worked out for the selected target from the definitions before them (`char pad[64 - sizeof(struct Head)]`), as are `&((T *)0)->m` and `sizeof(((T *)0)->m)`; `_Static_assert` is checked
- flexible array members (`int data[];`)
- bit-fields placed bit by bit by each compiler's own rules (GCC and Clang, MSVC, SDCC), including unnamed, zero-width, packed and `#pragma pack` ones; the walkthrough shows each field's bit range
- `#pragma pack(n)` with `push`/`pop`, `__attribute__((packed))`, Keil's and IAR's `__packed`, `__attribute__((aligned(n)))` on members, types and typedefs, `alignas` / `_Alignas`, `__declspec(align(n))`, packed enums. Under GCC `#pragma pack` caps alignment requests and `packed` does not; under MSVC `#pragma pack` caps natural alignment only, and `alignas` / `__declspec(align)` (also inside a struct used as a member) are never lowered
- **Packed mode** packs every definition in the syntax you choose, `#pragma pack(push, 1)`, `__attribute__((packed))` or `__packed`, offering only what the platform's compiler accepts (MSVC and the 8051 compilers: `#pragma pack`). Under GCC the pragma and the attribute differ where the source asks for alignment (`aligned`, `_Alignas`), which the pragma caps and the attribute does not. The Verification Code tool prints exactly the packed source the layout was computed from
- the preprocessor: object-like and function-like macros expanded as C11 specifies, with `#`, `##`, `__VA_ARGS__`, `__VA_OPT__` and GNU's `, ## __VA_ARGS__`; `#if`/`#ifdef`/`#elif`/`#else`; `#include` (skipped; standard types are built in). No macro is predefined
- **C++** (choose C++17 or C++20): classes laid out by the target's C++ ABI, the Itanium C++ ABI (GCC, Clang) or MSVC's on Windows: single, multiple and virtual base classes, the empty base optimization, the vptr (MSVC's vfptr), vbptr and vtordisp, tail padding reuse by the rules g++ applies to "POD for layout" (C++20 changes them for classes whose constructors are all defaulted or deleted), `[[no_unique_address]]`, `[[msvc::no_unique_address]]` and `__declspec(empty_bases)`. Which virtual functions override which is worked out from their signatures. Methods, static members and nested types take no space; the walkthrough says why each subobject is where it is. C++ in C source is an error, as it is for a C compiler

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

### Zig

A port of Zig 0.16's layout code (`Type.abiSize`, `Type.abiAlignment` and Sema's type resolution), with the comptime evaluation a type needs:

- **Structs:** the compiler sorts a plain struct's fields by descending alignment with an unstable sort (`std.sort.pdq`, ported step for step, so fields of equal alignment come out in its order). Tuples and `extern struct` keep declaration order; extern ones raise 128-bit integers to 16. `align(n)` on fields, `comptime` fields, zero-bit fields.
- **packed struct and packed union:** an integer of the fields' total bit width, inferred or written (`packed struct(u32)`), with each field's bit offset; nested packed types and enums with an integer tag. On big-endian targets the walkthrough numbers the bits in memory order.
- **Unions:** bare, `union(enum)`, `union(enum(u8))`, `union(Tag)`, extern and packed. The tag goes first unless the payload is more aligned. In Debug and ReleaseSafe a bare union carries a hidden safety tag, which the build-mode option shows.
- **Enums:** an explicit integer tag type, or the smallest one that counts the fields; non-exhaustive enums.
- **Other types:** integers of any width (`u24`, `i65`), `f16` to `f128` and the C types per target, pointers, slices and sentinels, optionals (`?*T`, `?[*]T` and `?[]T` use the zero pointer and an optional error set uses error code 0; allowzero and C pointers and everything else add a flag), error sets and error unions, vectors. Error codes are as wide as `--error-limit` needs (`u16` for its default, 65535), and a definition with more error names than it allows is an error. Vectors are laid out by LLVM's rule, or in Debug on x86-64 Linux by Zig's own x86-64 code generator, which aligns them by the CPU: 16 bytes, and 32 with AVX and 64 with AVX-512F (the CPU option, `-mcpu=x86_64_v3` and `x86_64_v4`).
- **Comptime:** constants and integer arithmetic, with fixed-width integers where they are declared (`const n: u16`, which overflow and `@clz` need), `@sizeOf`, `@alignOf`, `@bitSizeOf`, `@offsetOf`, `@Int`, `@Vector`, `@This`, `@FieldType`, `@typeInfo` (a `std.builtin.Type` value), `@clz`, `@ctz`, `@popCount`, `@intFromEnum`, `@import("builtin")` (`mode`, `cpu.arch`, `os.tag`, `abi`), and functions that return a type (`fn Pair(comptime T: type) type`) through `const`, `if` (with `|x|` captures), `switch`, `return` and method calls.
- **std types**, transcribed from the std sources (each type's fields and the declarations they refer to): `ArrayList` and the aligned forms, `AutoHashMap` and `StringHashMap` (whose `SafetyLock` is a byte in safe builds), `mem.Allocator`, `mem.Alignment`, `math.Log2Int`, `MultiArrayList`, `atomic.Value`, `Io.Mutex` and the other Io locks, `Io.Writer`, `Io.Reader`, `Io.Limit`, linked lists, `Random`, `PriorityQueue` and the bit sets.
- **Optimized order:** for an extern struct, the order Zig gives a plain struct, written out as an extern struct.

## How results are checked

The engines are tested against the real compilers, not against expected values written by hand.

**Compiler references.** What the compilers answered for every case on every target is recorded in `tests/references/` (one JSON file per suite: `c`, `cpp`, `verification`, `go`, `rust`, `zig`, `bindings`). Only a compiler's answer is ever recorded, never the engine's:

- Where a compiler is installed, its suite checks the engine against the compiler, and the recording against the compiler too. A recording that is missing or differs fails, so none goes stale. CI has every compiler: the Ubuntu job all but MSVC, and a Windows job MSVC for the C and C++ suites.
- Where one is not, the suite checks the engine against the recording. Every target is still checked: MSVC's on Linux, the cross compilers' on a machine with none.
- A binding, a reordered struct or a verification program is recorded with a digest of the code its compiler was given. When the generated code changes, the check fails until it is compiled and recorded again, rather than vouching for code no compiler has seen.
- `SP_RECORD_REFERENCES=1 pnpm test` records the installed compilers' answers (a compiler that is not installed keeps its recordings). `SP_USE_REFERENCES=1` checks against the recordings even where the compilers are installed.

| Language | Ground truth (`tests/`) |
|---|---|
| C, C++ | `verification-program.test.ts` builds and runs the Verification Code tool's program for every example in every mode (natural, packed, optimized), the C examples as C and C++17 and the C++ examples as C++17 and C++20, with gcc and g++ for x86-64 Linux and MSVC for x64 and x86 Windows, and 22 more cases as declared, and compares what it prints with what the Struct Layout tool shows |
| C, every target | `cross-compiler.test.ts` compiles every C example and the bit-field, enum, pointer, `sizeof`/`offsetof` and macro cases for 17 targets: GCC for x86-64, i386, ARM32 (Linux and arm-none-eabi), AArch64, RISC-V 32/64 (Linux and bare metal), MIPS (PIC32), big-endian PowerPC 32 and MIPS32 (Linux and bare metal) and AVR; MSVC for x64 and x86 Windows (its object files read directly); SDCC for the 8051. Every case is also compiled packed, as `#pragma pack(push, 1)` and as `__attribute__((packed))` wherever the compiler takes them, from the same source the Verification Code tool prints. It reads size, alignment, every `offsetof` and each bit-field's bit position (in memory order: from the most significant bit of each byte on big-endian targets) back from the object file, so cross compilers need not run anything |
| C++, every target | `cpp-compiler.test.ts` compiles each C++ case, and every example, as C++17 and C++20 with g++ for x86-64, i386, ARM32 (Linux and arm-none-eabi), AArch64, RISC-V 32/64, MIPS, PowerPC 32 and big-endian MIPS32, as C++17 with avr-g++ 7 (which predates C++20) for AVR, and with MSVC for x64 and x86. It reads size, alignment, size and alignment as a base, and every base class and virtual base offset from g++'s class dump (`-fdump-lang-class`, `-fdump-class-hierarchy` on avr-g++ 7), and every base, vfptr, vbptr, vtordisp and member offset from MSVC's layout report (`/d1reportAllClassLayout`) |
| Go | `go-compiler.test.ts` checks every case and its reordered version against `go/types` on all 14 architectures, then compiles and runs the generated verification code with `GOARCH=amd64` and `GOARCH=386` |
| Rust | `rust-compiler.test.ts` checks every example and 55 more cases (76 in all) on all 13 targets as compile-time assertions: size, alignment, each field's offset and size, and `Option<T>`'s size, with the stable compiler, and for AVR (tier 3) on nightly with core and alloc built from source. A case rustc refuses on a target (a 64-bit atomic on Cortex-M, `Arc` on AVR, std on bare metal) the engine must refuse too. On Windows the generated verification program is also compiled and run |
| Zig | `zig-compiler.test.ts` checks every example and 53 more cases on all 16 targets in Debug, ReleaseSafe and ReleaseFast, and on x86-64 Linux at each CPU level: size, alignment, the size of `?T` and every field's `@offsetOf` (`@bitOffsetOf` for packed structs), as compile-time checks with `zig build-obj`. Error unions are checked at nine `--error-limit` values from 0 to 2³²−1, on x86-64 Linux and AVR. What Zig rejects the engine must reject too, and the generated verification programs are built and run for the host |
| All | `cross-language.test.ts` checks the ports of the C examples that promise C's layout against the C engine on x86-64 Linux: the 8 Go ports (size, alignment and offsets; Go has no bit-fields), the 8 `extern` Zig ports (size, alignment, offsets and bit positions, bit-fields included) and the 6 `repr(C)` Rust ports (size and alignment) |
| Bindings | `bindings.test.ts` compiles every binding the Bindings tool writes, for every C example and its own cases on 13 targets, and reads its size and member offsets back in that language: Zig `comptime` checks with `zig build-obj` for each target, Rust `const` checks for each target triple (with core built from source on nightly for the tier-3 ones, MIPS and AVR), Go constant checks for each GOARCH, Python's `struct` and `ctypes`, and .NET's `Marshal.OffsetOf`. Each binding's own layout checks compile with it, and its round trip runs: in Python and C# for every target, in Rust, Zig and Go for this machine's own (and is compiled for the others where the toolchain can). Each also runs the way its usage says, as its user would: `rustc` and `zig run` on the file alone, `go test`, a new `dotnet` console project, `python` on the file. The Go files are as gofmt formats them |

The cross-compiler tests find GCC and SDCC on the PATH, or in WSL on Windows, and MSVC with vswhere on Windows (CI runs those on a Windows runner). On Ubuntu:

```bash
sudo apt install --no-install-recommends g++ gcc-i686-linux-gnu g++-i686-linux-gnu \
  gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
  gcc-riscv64-linux-gnu g++-riscv64-linux-gnu gcc-mipsel-linux-gnu g++-mipsel-linux-gnu \
  gcc-powerpc-linux-gnu g++-powerpc-linux-gnu gcc-mips-linux-gnu g++-mips-linux-gnu \
  gcc-arm-none-eabi gcc-riscv64-unknown-elf gcc-avr avr-libc sdcc
```

For Rust: `rustup target add <triple>` for each target, and `rustup toolchain install nightly --profile minimal -c rust-src` for the tier-3 ones. Without them, those targets are checked against the recorded answers.

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
| SP008 | warning | Something in the source has no effect here: an ignored `#pragma`, an attribute that is not modelled, a static assertion it cannot check | — |
| SP009 | warning | Packed mode with `__packed`: laid out like GCC's packed attribute, not checked against Keil or IAR | — |

### Go (GO)

| Code | Level | Meaning | Fix |
|---|---|---|---|
| GO000 | error | Syntax error, with its line | — |
| GO001 | warning / info | Another field order is smaller, or the same size with fewer bytes for the GC to scan (what `fieldalignment` reports) | Show optimized order |
| GO002 | warning | A 64-bit integer is not 8-byte aligned on 32-bit targets, in a file that uses `sync/atomic` | Show the 32-bit layout |
| GO003 | info | A zero-size last field adds padding | — |
| GO004 | error | A type cannot be laid out: unknown, an uninstantiated generic, or recursive | — |
| GO005 | info | A struct type is not used by the one shown | — |

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

### Zig (ZG)

| Code | Level | Meaning | Fix |
|---|---|---|---|
| ZG000 | error | Syntax error, or syntax not supported in a type (`while`, `for`), with its line | — |
| ZG001 | warning | An extern struct would be smaller with its fields reordered | Show optimized order |
| ZG002 | info | A bare union carries a safety tag in this build mode | Show ReleaseFast |
| ZG004 | error | What Zig rejects (an unknown name, a type an extern or packed container cannot hold, a container that holds itself, a value that does not fit its type, a `switch` that misses a value, more error names than `--error-limit` allows), or comptime code and std declarations that are not modelled, named in the message | — |
| ZG005 | info | comptime fields take no space | — |
| ZG006 | info | A type declaration is not used by the one shown | — |
| ZG007 | warning | A parser warning, with its line | — |

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

The compiler ground-truth tests use whichever of these are installed: `gcc`/`g++` and the cross compilers and SDCC (on the PATH or in WSL), MSVC (found with vswhere), `go`, `rustc`/`rustup` (and nightly with `rust-src` for the tier-3 targets), `zig` (0.16), `python` and `dotnet`. The rest are checked against the recorded answers. The full command list is in [docs/scripts.md](docs/scripts.md).

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
    src/codegen, bindings, examples  C verification code, the Bindings generator, examples
    src/go                           Go parser, gc layout, std types, codegen
    src/rust                         Rust lexer/parser, rustc_abi port, std prelude, codegen
    src/zig                          Zig lexer/parser, comptime evaluator, Zig 0.16 layout port, std prelude, codegen
  tools/layout    @sp/layout       C/C++ tool family (manifest, spec, catalogue, compute, lint, variants)
  tools/go-layout @sp/go-layout    Go tool family
  tools/rust-layout @sp/rust-layout Rust tool family
  tools/zig-layout @sp/zig-layout  Zig tool family
  registry/       @sp/registry     TOOL_MANIFESTS (eager) + loadTool(id) (lazy import per family)
  platform/       @sp/platform     host adapter: saved state, file saving (web today)
  ui/             @sp/ui           Panel, Button, CopyButton, Dialog, Overlay, theme tokens
tests/                         vitest, importing packages only through their public entry points
```

The engines all produce the same result shape. A struct, union or enum, in any language, goes through one visualizer, walkthrough, comparison and export path.

## Limitations

These results model compilers; they are not compilers. Not modelled:

- **C++:** templates (a template has no layout until instantiated) and template base classes; MSVC's `#pragma vtordisp` and `/vd` options (the default, `/vd1`, is used); the 8051 compilers and XC16 compile C only.
- **C:** bit-fields on XC16, Keil C51 and bare-metal AArch64 follow GCC's rules without a compiler check (SP004); Packed mode with Keil's and IAR's `__packed` is laid out like GCC's packed attribute, also unchecked (SP009); the 8-bit Microchip target is AVR, not 8-bit PIC; the compiler's predefined macros (`_WIN32`, `__SIZEOF_LONG__`...), so `#ifdef` on them takes the undefined branch everywhere; `__attribute__((mode))`, `vector_size` and `ms_struct` (reported when used).
- **Go:** TinyGo (planned); standard-library types beyond the common ones (declare them in the input to lay them out); types from other modules.
- **Rust:**
  - `repr(Rust)` shows what rustc 1.99 does today, which other versions may change.
  - Associated types (`<T as Trait>::Out`), `dyn`/`impl` values, `repr(simd)` and `cfg` attributes (fields under `cfg` are always included).
  - Platform-specific std types such as `Mutex` or `PathBuf`.
- **Zig:**
  - A plain struct's field order is what Zig 0.16 does, which later versions may change.
  - Comptime code with loops, assignments or `@Type`; the parts of `@typeInfo` that are not layout (a container's declarations, an error set's names, a function's details); the rest of `std`; other imports (each reported).
  - std types whose definition needs comptime loops, such as `EnumSet` and `EnumArray` (an error names them).
  - The error names std itself uses count against `--error-limit` too (over a hundred for `std.debug.print` on Linux, Windows and macOS), so a limit can be enough for the definition and not for a program that prints it.

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
