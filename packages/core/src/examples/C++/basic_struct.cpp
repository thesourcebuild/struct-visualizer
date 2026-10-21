#include <iostream>
#include <cstddef>

struct Example
{
    char a;
    int b;
    char c;
    double d;
};

int main()
{
    std::cout << "Size of struct Example: " << sizeof(struct Example) << " bytes\n";
    std::cout << std::endl;

    std::cout << "  " << std::setw(20) << std::left << "a" << " offset: " << std::setw(3) << std::right << offsetof(struct Example, a) << ", size: " << sizeof(((struct Example *)0)->a) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "b" << " offset: " << std::setw(3) << std::right << offsetof(struct Example, b) << ", size: " << sizeof(((struct Example *)0)->b) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "c" << " offset: " << std::setw(3) << std::right << offsetof(struct Example, c) << ", size: " << sizeof(((struct Example *)0)->c) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "d" << " offset: " << std::setw(3) << std::right << offsetof(struct Example, d) << ", size: " << sizeof(((struct Example *)0)->d) << std::endl;

    std::cout << std::endl;
    std::cout << "Compile with: g++ -std=c++17 -o struct_test struct_test.cpp" << std::endl;
    return 0;
}