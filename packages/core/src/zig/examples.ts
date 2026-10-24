/**
 * Zig samples for the Zig tool family. Each lays out its last type declaration.
 *
 * The first ones are the C examples written in Zig (same names, same fields), so a layout can be
 * compared across languages. The plain structs at the start stay plain to show how Zig reorders
 * fields; the rest are extern, which is C's layout, as a type shared with C would be.
 */
export interface ZigExample {
  name: string;
  code: string;
}

export const zigExamples: readonly ZigExample[] = [
  // ---- The C examples, in Zig
  {
    name: 'Basic Struct',
    code: `// A plain struct: Zig orders the fields by alignment. Write extern struct for the C layout.
const Example = struct {
    a: u8,
    b: i32,
    c: u8,
    d: f64,
};`,
  },
  {
    name: 'Optimized Struct',
    code: `const Optimized = struct {
    d: f64,
    b: i32,
    a: u8,
    c: u8,
};`,
  },
  {
    name: 'Nested Struct',
    code: `const Inner = struct {
    x: u8,
    y: i32,
};

const Outer = struct {
    a: u8,
    inner: Inner,
    b: u8,
};`,
  },
  {
    name: 'Array Members',
    code: `const ArrayExample = struct {
    name: [32]u8,
    id: i32,
    values: [4]f32,
    flag: u8,
};`,
  },
  {
    name: 'Pointer Members',
    code: `const Pointers = struct {
    a: u8,
    ptr1: *i32,
    b: u8,
    ptr2: *anyopaque,
    c: i16,
};`,
  },
  {
    name: 'Advanced Pointers (Double + Function)',
    code: `const CallbackContext = extern struct {
    id: c_int,
    tag: u8,
};

const AdvancedPointers = extern struct {
    matrix: [*c][*c]c_int,
    // A nullable C function pointer: ?*const fn is still one pointer.
    handler: ?*const fn (code: c_int, ctx: *CallbackContext) callconv(.c) void,
    context: *CallbackContext,
    flag: u8,
};`,
  },
  {
    name: 'Enum Members',
    code: `// A Zig enum is as small as its count allows: one byte here, not four.
const Color = enum {
    red,
    green,
    blue,
};

const Paint = struct {
    color: Color,
    opacity: u8,
    label: [8]u8,
};`,
  },
  {
    name: 'Typedef Enum Members',
    code: `// enum(c_int) gives the enums C's int size.
const Mode = enum(c_int) {
    off = 0,
    on = 1,
};

const Level = enum(c_int) {
    low = 1,
    high = 3,
};

const LevelT = Level;

const Device = extern struct {
    mode: Mode,
    level: LevelT,
    data: [2]c_int,
};`,
  },
  {
    name: 'Bitfield Complex',
    code: `// A packed struct is an integer of its fields' bits: here the 16 bits C's
// bit-fields take, from the least significant bit up as GCC numbers them.
const Bits = packed struct(u16) {
    mode: u3,
    state: u5,
    enabled: u1,
    err: u7,
};

const BitfieldComplex = extern struct {
    id: u32,
    bits: Bits,
    counter: u16,
    tag: u8,
};`,
  },
  {
    name: 'Basic Union',
    code: `const Data = extern union {
    int_value: c_int,
    float_value: f32,
    char_value: u8,
};`,
  },
  {
    name: 'Complex Union',
    code: `const Result = extern union {
    code: c_int,
    message: [16]u8,
    value: f64,
    ptr: ?*anyopaque,
};`,
  },
  {
    name: 'Struct with Nested Struct & Union',
    code: `const Coordinate = extern struct {
    x: c_int,
    y: c_int,
};

const Value = extern union {
    int_val: c_int,
    float_val: f32,
    double_val: f64,
};

const DataPacket = extern struct {
    location: Coordinate,
    data: Value,
    flag: u8,
};`,
  },
  {
    name: 'Advanced Mixed (Struct/Union/Arrays)',
    code: `const Point = extern struct {
    x: i16,
    y: i16,
};

const Payload = extern union {
    id: c_int,
    weight: f64,
    p: Point,
};

const Record = extern struct {
    points: [3]Point,
    payloads: [2]Payload,
    tag: u8,
};

const Container = extern union {
    record: Record,
    payload: Payload,
    origin: Point,
};`,
  },
  {
    name: 'Ultra-Complex Nested (Inline Struct/Union)',
    code: `// Zig writes C's anonymous structs and unions in place, as field types.
const Vector3 = extern struct { x: f32, y: f32, z: f32 };
const Matrix3x3 = extern struct { m: [3][3]f32 };
const Number = extern union { i: i32, f: f32, d: f64 };
const Metadata = extern struct { id: u16, flags: u8, priority: u8 };

const Payload = extern union {
    numeric: extern struct { count: i32, values: [4]f64 },
    text: extern struct { name: [32]u8, timestamp: u64 },
    variant: extern union {
        bytes: extern struct { raw: [16]u8 },
        bounds: extern struct { min: Vector3, max: Vector3 },
    },
};

const ComplexStruct = extern struct {
    tag: u8,
    version: u32,
    meta: Metadata,
    primary_value: Number,
    points: [5]Vector3,
    geometry: extern struct { transforms: [2]Matrix3x3, active: u8 },
    data: extern union {
        batch: extern struct { payloads: [3]Payload, payload_count: u16 },
        single: extern struct { payload: Payload },
        resource: extern union {
            system: extern struct { handle: i64, permissions: u32 },
            memory: extern struct { ptr: ?*anyopaque, size: usize },
        },
    },
    status: extern union {
        error_info: extern struct {
            @"error": extern union { error_code: i32, error_msg: [64]u8 },
            severity: u8,
        },
        stats: extern struct { success_ratio: f64 },
    },
    checksum: u8,
};`,
  },

  // ---- Zig-specific
  {
    name: 'extern struct for C',
    code: `// extern struct: C's layout, in declaration order.
const Packet = extern struct {
    flags: u8,
    seq: u64,
    port: u16,
    valid: bool,
};`,
  },
  {
    name: 'Tagged union',
    code: `// The tag goes first, unless the payload is more aligned than it.
const Shape = union(enum) {
    circle: f32,
    rect: struct { w: f32, h: f32 },
    point,
};`,
  },
  {
    name: 'Bare union (safety tag)',
    code: `// In Debug and ReleaseSafe a bare union carries a hidden tag, so that
// reading the wrong field is caught; ReleaseFast and ReleaseSmall drop it.
const Value = union {
    int: i64,
    float: f64,
    bytes: [8]u8,
};`,
  },
  {
    name: 'Optionals and error unions',
    code: `// ?*T and ?[]T use the null pointer; other optionals add a flag.
const Lookup = struct {
    hit: ?u32,
    node: ?*u8,
    name: ?[]const u8,
    status: anyerror!u16,
    done: bool,
};`,
  },
  {
    name: 'Slices and std types',
    code: `const std = @import("std");

const User = struct {
    name: []const u8,
    age: u8,
    tags: std.ArrayList([]const u8),
    scores: std.AutoHashMap(u32, f32),
    gpa: std.mem.Allocator,
};`,
  },
  {
    name: 'Packed struct',
    code: `// The fields are bits of one integer (u16 here), from the least significant up.
const Status = packed struct {
    ready: bool,
    failed: bool,
    code: u5,
    level: u9,
};`,
  },
  {
    name: 'Generic types',
    code: `fn Ring(comptime T: type, comptime n: usize) type {
    return struct {
        head: u16,
        items: [n]T,
        full: bool,
    };
}

const Buffers = struct {
    small: Ring(u8, 16),
    wide: Ring(u64, 4),
};`,
  },
  {
    name: 'Aligned fields and vectors',
    code: `const Particle = struct {
    pos: @Vector(4, f32),
    vel: @Vector(4, f32),
    mass: f32,
    // Own cache line: a field's alignment can exceed its type's.
    hits: u64 align(64),
};`,
  },
];
