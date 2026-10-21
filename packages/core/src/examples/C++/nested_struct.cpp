#include <iostream>
#include <cstddef>

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

int main()
{
    std::cout << "Size of struct Inner: " << sizeof(struct Inner) << " bytes\n";
    std::cout << std::endl;

    std::cout << "  " << std::setw(20) << std::left << "x" << " offset: " << std::setw(3) << std::right << offsetof(struct Inner, x) << ", size: " << sizeof(((struct Inner *)0)->x) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "y" << " offset: " << std::setw(3) << std::right << offsetof(struct Inner, y) << ", size: " << sizeof(((struct Inner *)0)->y) << std::endl;

    std::cout << std::endl;
    std::cout << "Compile with: g++ -std=c++17 -o struct_test struct_test.cpp" << std::endl;
    return 0;
}