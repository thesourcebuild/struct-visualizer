# C Code Examples for Struct Padding Verification

This document contains complete C programs that you can compile and run to verify the struct padding calculations shown in the web application.

## Example 1: Basic Struct

### Original Struct

```c
#include <stdio.h>
#include <stddef.h>

struct Example {
    char a;
    int b;
    char c;
    double d;
};

int main(void) {
    printf("Size of struct Example: %zu bytes\n", sizeof(struct Example));
    printf("\n");

    printf("%-20s offset: %3zu, size: %2zu\n", "a (char)",
        offsetof(struct Example, a), sizeof(((struct Example*)0)->a));
    printf("%-20s offset: %3zu, size: %2zu\n", "b (int)",
        offsetof(struct Example, b), sizeof(((struct Example*)0)->b));
    printf("%-20s offset: %3zu, size: %2zu\n", "c (char)",
        offsetof(struct Example, c), sizeof(((struct Example*)0)->c));
    printf("%-20s offset: %3zu, size: %2zu\n", "d (double)",
        offsetof(struct Example, d), sizeof(((struct Example*)0)->d));

    printf("\n");
    printf("Compile with: gcc -o example1 example1.c\n");
    printf("For detailed info: gcc -fpack-struct=0 -fdump-rtl-expand example1.c\n");

    return 0;
}
```

**Expected Output (x64):**

```
Size of struct Example: 24 bytes

a (char)             offset:   0, size:  1
b (int)              offset:   4, size:  4
c (char)             offset:   8, size:  1
d (double)           offset:  16, size:  8
```

## Example 2: Optimized Struct

### Struct Definition

```c
#include <stdio.h>
#include <stddef.h>

struct Optimized {
    double d;
    int b;
    char a;
    char c;
};

int main(void) {
    printf("Size of struct Optimized: %zu bytes\n", sizeof(struct Optimized));
    printf("\n");

    printf("%-20s offset: %3zu, size: %2zu\n", "d (double)",
        offsetof(struct Optimized, d), sizeof(((struct Optimized*)0)->d));
    printf("%-20s offset: %3zu, size: %2zu\n", "b (int)",
        offsetof(struct Optimized, b), sizeof(((struct Optimized*)0)->b));
    printf("%-20s offset: %3zu, size: %2zu\n", "a (char)",
        offsetof(struct Optimized, a), sizeof(((struct Optimized*)0)->a));
    printf("%-20s offset: %3zu, size: %2zu\n", "c (char)",
        offsetof(struct Optimized, c), sizeof(((struct Optimized*)0)->c));

    printf("\n");
    printf("Compile with: gcc -o example2 example2.c\n");
    printf("For detailed info: gcc -fpack-struct=0 -fdump-rtl-expand example2.c\n");

    return 0;
}
```

**Expected Output (x64):**

```
Size of struct Optimized: 16 bytes

d (double)           offset:   0, size:  8
b (int)              offset:   8, size:  4
a (char)             offset:  12, size:  1
c (char)             offset:  13, size:  1
```

## Example 3: Nested Struct

### Struct Definition

```c
#include <stdio.h>
#include <stddef.h>

struct Inner {
    char x;
    int y;
};

struct Outer {
    char a;
    struct Inner inner;
    char b;
};

int main(void) {
    printf("Size of struct Inner: %zu bytes\n", sizeof(struct Inner));
    printf("Size of struct Outer: %zu bytes\n", sizeof(struct Outer));
    printf("\n");

    printf("=== Outer struct members ===\n");
    printf("%-20s offset: %3zu, size: %2zu\n", "a (char)",
        offsetof(struct Outer, a), sizeof(((struct Outer*)0)->a));
    printf("%-20s offset: %3zu, size: %2zu\n", "inner (struct Inner)",
        offsetof(struct Outer, inner), sizeof(((struct Outer*)0)->inner));
    printf("%-20s offset: %3zu, size: %2zu\n", "b (char)",
        offsetof(struct Outer, b), sizeof(((struct Outer*)0)->b));

    printf("\n");
    printf("Compile with: gcc -o example3 example3.c\n");

    return 0;
}
```

## Example 4: Array Members

### Struct Definition

```c
#include <stdio.h>
#include <stddef.h>

struct ArrayExample {
    char name[32];
    int id;
    float values[4];
    char flag;
};

int main(void) {
    printf("Size of struct ArrayExample: %zu bytes\n", sizeof(struct ArrayExample));
    printf("\n");

    printf("%-20s offset: %3zu, size: %2zu\n", "name[32] (char)",
        offsetof(struct ArrayExample, name), sizeof(((struct ArrayExample*)0)->name));
    printf("%-20s offset: %3zu, size: %2zu\n", "id (int)",
        offsetof(struct ArrayExample, id), sizeof(((struct ArrayExample*)0)->id));
    printf("%-20s offset: %3zu, size: %2zu\n", "values[4] (float)",
        offsetof(struct ArrayExample, values), sizeof(((struct ArrayExample*)0)->values));
    printf("%-20s offset: %3zu, size: %2zu\n", "flag (char)",
        offsetof(struct ArrayExample, flag), sizeof(((struct ArrayExample*)0)->flag));

    printf("\n");
    printf("Compile with: gcc -o example4 example4.c\n");

    return 0;
}
```

## Example 5: Pointer Members

### Struct Definition

```c
#include <stdio.h>
#include <stddef.h>

struct Pointers {
    char a;
    int *ptr1;
    char b;
    void *ptr2;
    short c;
};

int main(void) {
    printf("Size of struct Pointers: %zu bytes\n", sizeof(struct Pointers));
    printf("\n");

    printf("%-20s offset: %3zu, size: %2zu\n", "a (char)",
        offsetof(struct Pointers, a), sizeof(((struct Pointers*)0)->a));
    printf("%-20s offset: %3zu, size: %2zu\n", "ptr1 (int*)",
        offsetof(struct Pointers, ptr1), sizeof(((struct Pointers*)0)->ptr1));
    printf("%-20s offset: %3zu, size: %2zu\n", "b (char)",
        offsetof(struct Pointers, b), sizeof(((struct Pointers*)0)->b));
    printf("%-20s offset: %3zu, size: %2zu\n", "ptr2 (void*)",
        offsetof(struct Pointers, ptr2), sizeof(((struct Pointers*)0)->ptr2));
    printf("%-20s offset: %3zu, size: %2zu\n", "c (short)",
        offsetof(struct Pointers, c), sizeof(((struct Pointers*)0)->c));

    printf("\n");
    printf("Compile with: gcc -o example5 example5.c\n");

    return 0;
}
```

## Example 6: Enum Members

### Struct Definition

```c
#include <stdio.h>
#include <stddef.h>
#include <stdint.h>

enum Color {
    COLOR_RED = 0,
    COLOR_GREEN = 2,
    COLOR_BLUE,
};

struct Paint {
    enum Color color;
    uint8_t opacity;
    char label[8];
};

int main(void) {
    printf("Size of struct Paint: %zu bytes\n", sizeof(struct Paint));
    printf("\n");

    printf("%-20s offset: %3zu, size: %2zu\n", "color (enum Color)",
        offsetof(struct Paint, color), sizeof(((struct Paint*)0)->color));
    printf("%-20s offset: %3zu, size: %2zu\n", "opacity (uint8_t)",
        offsetof(struct Paint, opacity), sizeof(((struct Paint*)0)->opacity));
    printf("%-20s offset: %3zu, size: %2zu\n", "label[8] (char)",
        offsetof(struct Paint, label), sizeof(((struct Paint*)0)->label));

    printf("\n");
    printf("Compile with: gcc -o example6 example6.c\n");

    return 0;
}
```

## Example 7: Typedef Enum Members

### Struct Definition

```c
#include <stdio.h>
#include <stddef.h>

typedef enum {
    MODE_OFF = 0,
    MODE_ON = 1,
} Mode;

typedef enum Level {
    LEVEL_LOW = 1,
    LEVEL_HIGH = 3,
} Level_t;

struct Device {
    Mode mode;
    Level_t level;
    int data[2];
};

int main(void) {
    printf("Size of struct Device: %zu bytes\n", sizeof(struct Device));
    printf("\n");

    printf("%-20s offset: %3zu, size: %2zu\n", "mode (Mode)",
        offsetof(struct Device, mode), sizeof(((struct Device*)0)->mode));
    printf("%-20s offset: %3zu, size: %2zu\n", "level (Level_t)",
        offsetof(struct Device, level), sizeof(((struct Device*)0)->level));
    printf("%-20s offset: %3zu, size: %2zu\n", "data[2] (int)",
        offsetof(struct Device, data), sizeof(((struct Device*)0)->data));

    printf("\n");
    printf("Compile with: gcc -o example7 example7.c\n");

    return 0;
}
```

## Architecture-Specific Testing

### Test on Different Architectures

#### For x86 (32-bit)

```bash
gcc -m32 -o test_x86 example.c
./test_x86
```

#### For x64 (64-bit)

```bash
gcc -m64 -o test_x64 example.c
./test_x64
```

#### For ARM (cross-compile)

```bash
arm-linux-gnueabi-gcc -o test_arm example.c
qemu-arm ./test_arm
```

#### For ARM64 (cross-compile)

```bash
aarch64-linux-gnu-gcc -o test_arm64 example.c
qemu-aarch64 ./test_arm64
```

## Advanced: Architecture Detection

```c
#include <stdio.h>
#include <stddef.h>

struct Example {
    char a;
    int b;
    char c;
    double d;
};

int main(void) {
    printf("=== ARCHITECTURE INFORMATION ===\n");
    printf("sizeof(char):      %zu\n", sizeof(char));
    printf("sizeof(short):     %zu\n", sizeof(short));
    printf("sizeof(int):       %zu\n", sizeof(int));
    printf("sizeof(long):      %zu\n", sizeof(long));
    printf("sizeof(long long): %zu\n", sizeof(long long));
    printf("sizeof(float):     %zu\n", sizeof(float));
    printf("sizeof(double):    %zu\n", sizeof(double));
    printf("sizeof(void*):     %zu\n", sizeof(void*));
    printf("\n");

    printf("=== STRUCT EXAMPLE ===\n");
    printf("Total size: %zu bytes\n", sizeof(struct Example));
    printf("Alignment:  %zu bytes\n", _Alignof(struct Example));
    printf("\n");

    printf("Member layout:\n");
    printf("  [%3zu] %-15s (%-10s) size: %2zu, align: %2zu\n",
        offsetof(struct Example, a), "a", "char",
        sizeof(((struct Example*)0)->a),
        _Alignof(typeof(((struct Example*)0)->a)));

    printf("  [%3zu] %-15s (%-10s) size: %2zu, align: %2zu\n",
        offsetof(struct Example, b), "b", "int",
        sizeof(((struct Example*)0)->b),
        _Alignof(typeof(((struct Example*)0)->b)));

    printf("  [%3zu] %-15s (%-10s) size: %2zu, align: %2zu\n",
        offsetof(struct Example, c), "c", "char",
        sizeof(((struct Example*)0)->c),
        _Alignof(typeof(((struct Example*)0)->c)));

    printf("  [%3zu] %-15s (%-10s) size: %2zu, align: %2zu\n",
        offsetof(struct Example, d), "d", "double",
        sizeof(((struct Example*)0)->d),
        _Alignof(typeof(((struct Example*)0)->d)));

    return 0;
}
```

## Comparison Script

Create a script to compare original vs optimized:

```c
#include <stdio.h>
#include <stddef.h>

/* Original Structure */
struct Example {
    char a;
    int b;
    char c;
    double d;
};

/* Optimized Structure */
struct Example_optimized {
    double d;
    int b;
    char a;
    char c;
};

int main(void) {
    printf("=== ORIGINAL STRUCTURE ===\n");
    printf("Size: %zu bytes\n\n", sizeof(struct Example));

    printf("=== OPTIMIZED STRUCTURE ===\n");
    printf("Size: %zu bytes\n\n", sizeof(struct Example_optimized));

    printf("=== SAVINGS ===\n");
    printf("Bytes saved: %zd\n",
        (long)(sizeof(struct Example) - sizeof(struct Example_optimized)));
    printf("Percentage: %.1f%%\n",
        100.0 * (1.0 - (double)sizeof(struct Example_optimized) / sizeof(struct Example)));

    return 0;
}
```

## Makefile for All Examples

```makefile
CC = gcc
CFLAGS = -Wall -Wextra -std=c11

all: example1 example2 example3 example4 example5 comparison arch_test

example1: example1.c
 $(CC) $(CFLAGS) -o example1 example1.c

example2: example2.c
 $(CC) $(CFLAGS) -o example2 example2.c

example3: example3.c
 $(CC) $(CFLAGS) -o example3 example3.c

example4: example4.c
 $(CC) $(CFLAGS) -o example4 example4.c

example5: example5.c
 $(CC) $(CFLAGS) -o example5 example5.c

comparison: comparison.c
 $(CC) $(CFLAGS) -o comparison comparison.c

arch_test: arch_test.c
 $(CC) $(CFLAGS) -o arch_test arch_test.c

run: all
 ./example1
 ./example2
 ./example3
 ./example4
 ./example5
 ./comparison
 ./arch_test

clean:
 rm -f example1 example2 example3 example4 example5 comparison arch_test

.PHONY: all run clean
```

## Usage

1. Copy any example code into a `.c` file
2. Compile with `gcc -o test test.c`
3. Run with `./test`
4. Compare output with the web calculator results

## Notes

- Results may vary slightly between different compilers (GCC, Clang, MSVC)
- Packed structs (`#pragma pack`) will show different results
- Cross-platform differences are expected
- Always verify with actual compiler output for production code
