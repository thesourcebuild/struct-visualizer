#include <stdio.h>
#include <stddef.h>

struct Optimized
{
    double d;
    int b;
    char a;
    char c;
};

int main(void)
{
    printf("Size of struct Optimized: %zu bytes\n", sizeof(struct Optimized));
    printf("\n");

    printf("    %-16s offset: %3zu, size: %zu\n", "d", offsetof(struct Optimized, d), sizeof(((struct Optimized *)0)->d));
    printf("    %-16s offset: %3zu, size: %zu\n", "b", offsetof(struct Optimized, b), sizeof(((struct Optimized *)0)->b));
    printf("    %-16s offset: %3zu, size: %zu\n", "a", offsetof(struct Optimized, a), sizeof(((struct Optimized *)0)->a));
    printf("    %-16s offset: %3zu, size: %zu\n", "c", offsetof(struct Optimized, c), sizeof(((struct Optimized *)0)->c));

    printf("\n");
    printf("Compile with: gcc -o struct_test struct_test.c\n");
    printf("For detailed info: gcc -fpack-struct=0 -fdump-rtl-expand struct_test.c\n");

    return 0;
}