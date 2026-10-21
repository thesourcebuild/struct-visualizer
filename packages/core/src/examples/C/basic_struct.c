#include <stdio.h>
#include <stddef.h>

struct Example
{
    char a;
    int b;
    char c;
    double d;
};

int main(void)
{
    printf("Size of struct Example: %zu bytes\n", sizeof(struct Example));
    printf("\n");

    printf("    %-16s offset: %3zu, size: %zu\n", "a", offsetof(struct Example, a), sizeof(((struct Example *)0)->a));
    printf("    %-16s offset: %3zu, size: %zu\n", "b", offsetof(struct Example, b), sizeof(((struct Example *)0)->b));
    printf("    %-16s offset: %3zu, size: %zu\n", "c", offsetof(struct Example, c), sizeof(((struct Example *)0)->c));
    printf("    %-16s offset: %3zu, size: %zu\n", "d", offsetof(struct Example, d), sizeof(((struct Example *)0)->d));

    printf("\n");
    printf("Compile with: gcc -o struct_test struct_test.c\n");
    printf("For detailed info: gcc -fpack-struct=0 -fdump-rtl-expand struct_test.c\n");

    return 0;
}