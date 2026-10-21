#include <iostream>
#include <cstddef>

struct ArrayExample
{
    char name[32];
    int id;
    float values[4];
    char flag;
};

int main()
{
    std::cout << "Size of struct ArrayExample: " << sizeof(struct ArrayExample) << " bytes\n";
    std::cout << std::endl;

    std::cout << "  " << std::setw(20) << std::left << "name" << " offset: " << std::setw(3) << std::right << offsetof(struct ArrayExample, name) << ", size: " << sizeof(((struct ArrayExample *)0)->name) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "id" << " offset: " << std::setw(3) << std::right << offsetof(struct ArrayExample, id) << ", size: " << sizeof(((struct ArrayExample *)0)->id) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "values" << " offset: " << std::setw(3) << std::right << offsetof(struct ArrayExample, values) << ", size: " << sizeof(((struct ArrayExample *)0)->values) << std::endl;
    std::cout << "  " << std::setw(20) << std::left << "flag" << " offset: " << std::setw(3) << std::right << offsetof(struct ArrayExample, flag) << ", size: " << sizeof(((struct ArrayExample *)0)->flag) << std::endl;

    std::cout << std::endl;
    std::cout << "Compile with: g++ -std=c++17 -o struct_test struct_test.cpp" << std::endl;
    return 0;
}