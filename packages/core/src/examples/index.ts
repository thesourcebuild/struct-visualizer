// Examples inlined to avoid Turbopack unknown module types

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
    code: { c: string; cpp: string };
}

export const examples: readonly StructExample[] = [
    {
        name: 'Basic Struct',
        code: {
            c: basicStruct,
            cpp: basicStruct,
        },
    },
    {
        name: 'Optimized Struct',
        code: {
            c: optimizedStruct,
            cpp: optimizedStruct,
        },
    },
    {
        name: 'Nested Struct',
        code: {
            c: nestedStruct,
            cpp: nestedStruct,
        },
    },
    {
        name: 'Array Members',
        code: {
            c: arrayMembers,
            cpp: arrayMembers,
        },
    },
    {
        name: 'Pointer Members',
        code: {
            c: pointerMembers,
            cpp: pointerMembers,
        },
    },
    {
        name: 'Advanced Pointers (Double + Function)',
        code: {
            c: advancedPointers,
            cpp: advancedPointers,
        },
    },
    {
        name: 'Enum Members',
        code: {
            c: enumMembers,
            cpp: enumMembers,
        },
    },
    {
        name: 'Typedef Enum Members',
        code: {
            c: typedefEnumMembers,
            cpp: typedefEnumMembers,
        },
    },
    {
        name: 'Bitfield Complex',
        code: {
            c: bitfieldComplex,
            cpp: bitfieldComplex,
        },
    },
    {
        name: 'Basic Union',
        code: {
            c: basicUnion,
            cpp: basicUnion,
        },
    },
    {
        name: 'Complex Union',
        code: {
            c: complexUnion,
            cpp: complexUnion,
        },
    },
    {
        name: 'Struct with Nested Struct & Union',
        code: {
            c: mixedStructUnion,
            cpp: mixedStructUnion,
        },
    },
    {
        name: 'Advanced Mixed (Struct/Union/Arrays)',
        code: {
            c: mixedComplex,
            cpp: mixedComplex,
        },
    },
    {
        name: 'Ultra-Complex Nested (Inline Struct/Union)',
        code: {
            c: complexNested,
            cpp: complexNested,
        },
    },
];
