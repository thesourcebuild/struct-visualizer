#include <iostream>
#include <cstddef>

struct Pointers
{
    char a;
    int *ptr1;
    char b;
    void *ptr2;
    short c;
};

int main()
{
    std::cout << "Size of struct Pointers: " << sizeof(struct Pointers) << " bytes\n";
    std::cout << std::endl;

    std::cout << "  " << std::setw(20) << std::left << "a" << " offset: " << std::setw(3) << std::right << offsetof(struct Pointers, a) << ", size: " << sizeof(((struct Pointers *)0)->a) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "ptr1" << " offset: " << std::setw(3) << std::right << offsetof(struct Pointers, ptr1) << ", size: " << sizeof(((struct Pointers *)0)->ptr1) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "b" << " offset: " << std::setw(3) << std::right << offsetof(struct Pointers, b) << ", size: " << sizeof(((struct Pointers *)0)->b) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "ptr2" << " offset: " << std::setw(3) << std::right << offsetof(struct Pointers, ptr2) << ", size: " << sizeof(((struct Pointers *)0)->ptr2) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "c" << " offset: " << std::setw(3) << std::right << offsetof(struct Pointers, c) << ", size: " << sizeof(((struct Pointers *)0)->c) << std::endl;

    std::cout << std::endl;
    std::cout << "Compile with: g++ -std=c++17 -o struct_test struct_test.cpp" << std::endl;
    return 0;
}