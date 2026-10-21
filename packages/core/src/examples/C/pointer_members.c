#include <stdio.h>
#include <stddef.h>

struct Pointers
{
    char a;
    int *ptr1;
    char b;
    void *ptr2;
    short c;
};

int main(void)
{
    printf("Size of struct Pointers: %zu bytes\n", sizeof(struct Pointers));
    printf("\n");

    printf("    %-16s offset: %3zu, size: %zu\n", "a", offsetof(struct Pointers, a), sizeof(((struct Pointers *)0)->a));
    printf("    %-16s offset: %3zu, size: %zu\n", "ptr1", offsetof(struct Pointers, ptr1), sizeof(((struct Pointers *)0)->ptr1));
    printf("    %-16s offset: %3zu, size: %zu\n", "b", offsetof(struct Pointers, b), sizeof(((struct Pointers *)0)->b));
    printf("    %-16s offset: %3zu, size: %zu\n", "ptr2", offsetof(struct Pointers, ptr2), sizeof(((struct Pointers *)0)->ptr2));
    printf("    %-16s offset: %3zu, size: %zu\n", "c", offsetof(struct Pointers, c), sizeof(((struct Pointers *)0)->c));

    printf("\n");
    printf("Compile with: gcc -o struct_test struct_test.c\n");
    printf("For detailed info: gcc -fpack-struct=0 -fdump-rtl-expand struct_test.c\n");

    return 0;
}