#include <iostream>
#include <cstddef>

struct Optimized
{
    double d;
    int b;
    char a;
    char c;
};

int main()
{
    std::cout << "Size of struct Optimized: " << sizeof(struct Optimized) << " bytes\n";
    std::cout << std::endl;

    std::cout << "  " << std::setw(20) << std::left << "d" << " offset: " << std::setw(3) << std::right << offsetof(struct Optimized, d) << ", size: " << sizeof(((struct Optimized *)0)->d) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "b" << " offset: " << std::setw(3) << std::right << offsetof(struct Optimized, b) << ", size: " << sizeof(((struct Optimized *)0)->b) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "a" << " offset: " << std::setw(3) << std::right << offsetof(struct Optimized, a) << ", size: " << sizeof(((struct Optimized *)0)->a) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "c" << " offset: " << std::setw(3) << std::right << offsetof(struct Optimized, c) << ", size: " << sizeof(((struct Optimized *)0)->c) << std::endl;

    std::cout << std::endl;
    std::cout << "Compile with: g++ -std=c++17 -o struct_test struct_test.cpp" << std::endl;
    return 0;
}