#include <stdio.h>
#include <stddef.h>

struct Inner
{
    char x;
    int y;
};

struct Outer
{
    char a;
    struct Inner inner;
    char b;
};

int main(void)
{
    printf("Size of struct Inner: %zu bytes\n", sizeof(struct Inner));
    printf("\n");

    printf("    %-16s offset: %3zu, size: %zu\n", "x", offsetof(struct Inner, x), sizeof(((struct Inner *)0)->x));
    printf("    %-16s offset: %3zu, size: %zu\n", "y", offsetof(struct Inner, y), sizeof(((struct Inner *)0)->y));

    printf("\n");
    printf("Compile with: gcc -o struct_test struct_test.c\n");
    printf("For detailed info: gcc -fpack-struct=0 -fdump-rtl-expand struct_test.c\n");

    return 0;
}