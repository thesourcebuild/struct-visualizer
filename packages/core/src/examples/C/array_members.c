#include <stdio.h>
#include <stddef.h>

struct ArrayExample
{
    char name[32];
    int id;
    float values[4];
    char flag;
};

int main(void)
{
    printf("Size of struct ArrayExample: %zu bytes\n", sizeof(struct ArrayExample));
    printf("\n");

    printf("    %-16s offset: %3zu, size: %zu\n", "name", offsetof(struct ArrayExample, name), sizeof(((struct ArrayExample *)0)->name));
    printf("    %-16s offset: %3zu, size: %zu\n", "id", offsetof(struct ArrayExample, id), sizeof(((struct ArrayExample *)0)->id));
    printf("    %-16s offset: %3zu, size: %zu\n", "values", offsetof(struct ArrayExample, values), sizeof(((struct ArrayExample *)0)->values));
    printf("    %-16s offset: %3zu, size: %zu\n", "flag", offsetof(struct ArrayExample, flag), sizeof(((struct ArrayExample *)0)->flag));

    printf("\n");
    printf("Compile with: gcc -o struct_test struct_test.c\n");
    printf("For detailed info: gcc -fpack-struct=0 -fdump-rtl-expand struct_test.c\n");

    return 0;
}