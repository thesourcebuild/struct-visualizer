// Examples inlined to avoid Turbopack unknown module types
import type { SourceLanguage } from '../types';

// C++: the class laid out is the last one, as for C.
const cppTailPadding = `// Header has a constructor, so it is not "POD for layout": under the
// Itanium C++ ABI (GCC, Clang) Packet's members go into Header's tail
// padding. MSVC never reuses it, so Packet is larger on Windows.
struct Header
{
    Header();
    uint32_t id;
    uint8_t flags;
};

struct Packet : Header
{
    uint8_t kind;
    uint16_t length;
};`;

const cppVirtualFunctions = `// A class with virtual functions starts with a pointer to its virtual
// function table (vptr). Circle shares Shape's, as its primary base.
struct Shape
{
    virtual ~Shape();
    virtual double area() const = 0;
    uint8_t layer;
};

struct Circle : Shape
{
    double area() const override;
    float radius;
};`;

const cppDiamond = `// One Node subobject, shared by Left and Right. Each reaches it through
// the vptr (Itanium) or a virtual base table pointer, vbptr (MSVC).
struct Node
{
    int id;
};

struct Left : virtual Node
{
    char l;
};

struct Right : virtual Node
{
    short r;
};

struct Diamond : Left, Right
{
    char d;
};`;

const cppEmptyBases = `// Empty base classes take no space (the empty base optimization).
// MSVC gives the second one a byte unless the class has
// __declspec(empty_bases).
struct Tag {};
struct Allocator {};

struct Vec : Tag, Allocator
{
    int *data;
    unsigned size;
};`;

const basicStruct = `struct Example
{
    char a;
    int b;
    char c;
    double d;
};`;

const optimizedStruct = `struct Optimized
{
    double d;
    int b;
    char a;
    char c;
};`;

const nestedStruct = `struct Inner
{
    char x;
    int y;
};

struct Outer
{
    char a;
    struct Inner inner;
    char b;
};`;

const arrayMembers = `struct ArrayExample
{
    char name[32];
    int id;
    float values[4];
    char flag;
};`;

const pointerMembers = `struct Pointers
{
    char a;
    int *ptr1;
    char b;
    void *ptr2;
    short c;
};`;

const advancedPointers = `struct CallbackContext
{
    int id;
    char tag;
};

struct AdvancedPointers
{
    int **matrix;
    void (*handler)(int code, struct CallbackContext *ctx);
    struct CallbackContext *context;
    char flag;
};`;

const enumMembers = `enum Color
{
    COLOR_RED = 0,
    COLOR_GREEN = 2,
    COLOR_BLUE,
};

struct Paint
{
    enum Color color;
    uint8_t opacity;
    char label[8];
};`;

const typedefEnumMembers = `typedef enum
{
    MODE_OFF = 0,
    MODE_ON = 1,
} Mode;

typedef enum Level
{
    LEVEL_LOW = 1,
    LEVEL_HIGH = 3,
} Level_t;

struct Device
{
    Mode mode;
    Level_t level;
    int data[2];
};`;

const bitfieldComplex = `struct BitfieldComplex
{
    uint32_t id;
    unsigned int mode : 3;
    unsigned int state : 5;
    unsigned int enabled : 1;
    unsigned int error : 7;
    uint16_t counter;
    char tag;
};`;

const basicUnion = `union Data
{
    int intValue;
    float floatValue;
    char charValue;
};`;

const complexUnion = `union Result
{
        int code;
        char message[16];
        double value;
        void *ptr;
};`;

const mixedStructUnion = `struct Coordinate
{
    int x;
    int y;
};

union Value
{
    int intVal;
    float floatVal;
    double doubleVal;
};

struct DataPacket
{
    struct Coordinate location;
    union Value data;
    char flag;
};`;

const mixedComplex = `struct Point
{
        short x;
        short y;
};

union Payload
{
        int id;
        double weight;
        struct Point p;
};

struct Record
{
        struct Point points[3];
        union Payload payloads[2];
        char tag;
};

union Container
{
        struct Record record;
        union Payload payload;
        struct Point origin;
};`;

const complexNested = `struct Vector3 {
        float x;
        float y;
        float z;
};

struct Matrix3x3 {
        float m[3][3];
};

union Number {
        int32_t i;
        float f;
        double d;
};

struct Metadata {
        uint16_t id;
        uint8_t flags;
        uint8_t priority;
};

union Payload {
        struct {
                int32_t count;
                double values[4];
        } numeric;

        struct {
                char name[32];
                uint64_t timestamp;
        } text;

        union {
                struct {
                        uint8_t raw[16];
                } bytes;

                struct {
                        struct Vector3 min;
                        struct Vector3 max;
                } bounds;
        } variant;
};

struct ComplexStruct {
        /* Basic fields */
        char tag;
        uint32_t version;

        /* Nested struct */
        struct Metadata meta;

        /* Union with primitives */
        union Number primary_value;

        /* Array of structs */
        struct Vector3 points[5];

        /* Nested struct containing array */
        struct {
                struct Matrix3x3 transforms[2];
                uint8_t active;
        } geometry;

        /* Union containing structs and unions */
        union {
                struct {
                    union Payload payloads[3];
                        uint16_t payload_count;
                } batch;

                struct {
                    union Payload payload;
                } single;

                union {
                        struct {
                                int64_t handle;
                                uint32_t permissions;
                        } system;

                        struct {
                                void* ptr;
                                size_t size;
                        } memory;
                } resource;
        } data;

        /* Union inside struct inside union (yes, really) */
        union {
                struct {
                        union {
                                int32_t error_code;
                                char error_msg[64];
                        } error;
                        uint8_t severity;
                } error_info;

                struct {
                        double success_ratio;
                } stats;
        } status;

        /* Trailing fields */
        uint8_t checksum;
};`;
export interface StructExample {
    name: string;
    code: string;
    /** C examples are also valid C++. */
    language: SourceLanguage;
}

export const examples: readonly StructExample[] = [
    {
        name: 'Basic Struct',
        code: basicStruct,
        language: 'c',
    },
    {
        name: 'Optimized Struct',
        code: optimizedStruct,
        language: 'c',
    },
    {
        name: 'Nested Struct',
        code: nestedStruct,
        language: 'c',
    },
    {
        name: 'Array Members',
        code: arrayMembers,
        language: 'c',
    },
    {
        name: 'Pointer Members',
        code: pointerMembers,
        language: 'c',
    },
    {
        name: 'Advanced Pointers (Double + Function)',
        code: advancedPointers,
        language: 'c',
    },
    {
        name: 'Enum Members',
        code: enumMembers,
        language: 'c',
    },
    {
        name: 'Typedef Enum Members',
        code: typedefEnumMembers,
        language: 'c',
    },
    {
        name: 'Bitfield Complex',
        code: bitfieldComplex,
        language: 'c',
    },
    {
        name: 'Basic Union',
        code: basicUnion,
        language: 'c',
    },
    {
        name: 'Complex Union',
        code: complexUnion,
        language: 'c',
    },
    {
        name: 'Struct with Nested Struct & Union',
        code: mixedStructUnion,
        language: 'c',
    },
    {
        name: 'Advanced Mixed (Struct/Union/Arrays)',
        code: mixedComplex,
        language: 'c',
    },
    {
        name: 'Ultra-Complex Nested (Inline Struct/Union)',
        code: complexNested,
        language: 'c',
    },
    {
        name: 'C++: Inheritance and Tail Padding',
        code: cppTailPadding,
        language: 'c++17',
    },
    {
        name: 'C++: Virtual Functions',
        code: cppVirtualFunctions,
        language: 'c++17',
    },
    {
        name: 'C++: Virtual Inheritance (Diamond)',
        code: cppDiamond,
        language: 'c++17',
    },
    {
        name: 'C++: Empty Bases',
        code: cppEmptyBases,
        language: 'c++17',
    },
];
