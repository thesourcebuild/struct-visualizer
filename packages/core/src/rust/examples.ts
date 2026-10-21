/**
 * Rust samples for the Rust tool family. Each lays out its last definition.
 *
 * The first ones are the C examples written in Rust (same names, same fields), so a layout can
 * be compared across languages. Plain structs are left as repr(Rust) to show rustc's reordering;
 * the union examples use repr(C), as a union shared with C would.
 */
export interface RustExample {
  name: string;
  code: string;
}

export const rustExamples: readonly RustExample[] = [
  // ---- The C examples, in Rust
  {
    name: 'Basic Struct',
    code: `// repr(Rust): rustc reorders the fields. Add #[repr(C)] for the C layout.
struct Example {
    a: u8,
    b: i32,
    c: u8,
    d: f64,
}`,
  },
  {
    name: 'Optimized Struct',
    code: `struct Optimized {
    d: f64,
    b: i32,
    a: u8,
    c: u8,
}`,
  },
  {
    name: 'Nested Struct',
    code: `struct Inner {
    x: u8,
    y: i32,
}

struct Outer {
    a: u8,
    inner: Inner,
    b: u8,
}`,
  },
  {
    name: 'Array Members',
    code: `struct ArrayExample {
    name: [u8; 32],
    id: i32,
    values: [f32; 4],
    flag: u8,
}`,
  },
  {
    name: 'Pointer Members',
    code: `use core::ffi::c_void;

struct Pointers {
    a: u8,
    ptr1: *mut i32,
    b: u8,
    ptr2: *mut c_void,
    c: i16,
}`,
  },
  {
    name: 'Advanced Pointers (Double + Function)',
    code: `struct CallbackContext {
    id: i32,
    tag: u8,
}

struct AdvancedPointers {
    matrix: *mut *mut i32,
    // A nullable C function pointer: Option<fn> is still one pointer (niche).
    handler: Option<fn(code: i32, ctx: *mut CallbackContext)>,
    context: *mut CallbackContext,
    flag: u8,
}`,
  },
  {
    name: 'Enum Members',
    code: `// A Rust enum is as small as its values allow: one byte here, not four.
enum Color {
    Red = 0,
    Green = 2,
    Blue,
}

struct Paint {
    color: Color,
    opacity: u8,
    label: [u8; 8],
}`,
  },
  {
    name: 'Typedef Enum Members',
    code: `// repr(C) gives the enums C's int size; a type alias plays typedef's role.
#[repr(C)]
enum Mode {
    Off = 0,
    On = 1,
}

#[repr(C)]
enum Level {
    Low = 1,
    High = 3,
}

type LevelT = Level;

#[repr(C)]
struct Device {
    mode: Mode,
    level: LevelT,
    data: [i32; 2],
}`,
  },
  {
    name: 'Bit Flags (instead of bit-fields)',
    code: `// Rust has no bit-fields: pack them into an integer and mask.
// flags holds mode (3 bits), state (5), enabled (1) and error (7).
struct BitfieldComplex {
    id: u32,
    flags: u16,
    counter: u16,
    tag: u8,
}`,
  },
  {
    name: 'Basic Union',
    code: `#[repr(C)]
union Data {
    int_value: i32,
    float_value: f32,
    char_value: u8,
}`,
  },
  {
    name: 'Complex Union',
    code: `use core::ffi::c_void;

#[repr(C)]
union Outcome {
    code: i32,
    message: [u8; 16],
    value: f64,
    ptr: *mut c_void,
}`,
  },
  {
    name: 'Struct with Nested Struct & Union',
    code: `#[derive(Clone, Copy)]
#[repr(C)]
struct Coordinate {
    x: i32,
    y: i32,
}

#[repr(C)]
union Value {
    int_val: i32,
    float_val: f32,
    double_val: f64,
}

#[repr(C)]
struct DataPacket {
    location: Coordinate,
    data: Value,
    flag: u8,
}`,
  },
  {
    name: 'Advanced Mixed (Struct/Union/Arrays)',
    code: `// Union fields must be Copy, hence the derives.
#[derive(Clone, Copy)]
#[repr(C)]
struct Point {
    x: i16,
    y: i16,
}

#[derive(Clone, Copy)]
#[repr(C)]
union Payload {
    id: i32,
    weight: f64,
    p: Point,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct Record {
    points: [Point; 3],
    payloads: [Payload; 2],
    tag: u8,
}

#[repr(C)]
union Container {
    record: Record,
    payload: Payload,
    origin: Point,
}`,
  },
  {
    name: 'Ultra-Complex Nested (Inline Struct/Union)',
    code: `// The C version's anonymous structs and unions need names in Rust.
use core::ffi::c_void;

#[derive(Clone, Copy)] #[repr(C)] struct Vector3 { x: f32, y: f32, z: f32 }
#[derive(Clone, Copy)] #[repr(C)] struct Matrix3x3 { m: [[f32; 3]; 3] }
#[derive(Clone, Copy)] #[repr(C)] union Number { i: i32, f: f32, d: f64 }
#[derive(Clone, Copy)] #[repr(C)] struct Metadata { id: u16, flags: u8, priority: u8 }

#[derive(Clone, Copy)] #[repr(C)] struct Numeric { count: i32, values: [f64; 4] }
#[derive(Clone, Copy)] #[repr(C)] struct Text { name: [u8; 32], timestamp: u64 }
#[derive(Clone, Copy)] #[repr(C)] struct Bytes { raw: [u8; 16] }
#[derive(Clone, Copy)] #[repr(C)] struct Bounds { min: Vector3, max: Vector3 }
#[derive(Clone, Copy)] #[repr(C)] union Variant { bytes: Bytes, bounds: Bounds }
#[derive(Clone, Copy)] #[repr(C)] union Payload { numeric: Numeric, text: Text, variant: Variant }

#[derive(Clone, Copy)] #[repr(C)] struct Geometry { transforms: [Matrix3x3; 2], active: u8 }

#[derive(Clone, Copy)] #[repr(C)] struct Batch { payloads: [Payload; 3], payload_count: u16 }
#[derive(Clone, Copy)] #[repr(C)] struct Single { payload: Payload }
#[derive(Clone, Copy)] #[repr(C)] struct System { handle: i64, permissions: u32 }
#[derive(Clone, Copy)] #[repr(C)] struct Memory { ptr: *mut c_void, size: usize }
#[derive(Clone, Copy)] #[repr(C)] union Resource { system: System, memory: Memory }
#[derive(Clone, Copy)] #[repr(C)] union DataUnion { batch: Batch, single: Single, resource: Resource }

#[derive(Clone, Copy)] #[repr(C)] union ErrorDetail { error_code: i32, error_msg: [u8; 64] }
#[derive(Clone, Copy)] #[repr(C)] struct ErrorInfo { error: ErrorDetail, severity: u8 }
#[derive(Clone, Copy)] #[repr(C)] struct Stats { success_ratio: f64 }
#[derive(Clone, Copy)] #[repr(C)] union Status { error_info: ErrorInfo, stats: Stats }

#[repr(C)]
struct ComplexStruct {
    tag: u8,
    version: u32,
    meta: Metadata,
    primary_value: Number,
    points: [Vector3; 5],
    geometry: Geometry,
    data: DataUnion,
    status: Status,
    checksum: u8,
}`,
  },

  // ---- Rust-specific
  {
    name: 'repr(C) for FFI',
    code: `#[repr(C)]
struct Packet {
    flags: u8,
    seq: u64,
    port: u16,
    valid: bool,
}`,
  },
  {
    name: 'Strings, vectors and boxes',
    code: `struct User {
    active: bool,
    name: String,
    age: u8,
    tags: Vec<String>,
    avatar: Option<Box<[u8]>>,
}`,
  },
  {
    name: 'Enum with data (tagged)',
    code: `enum Shape {
    Circle { radius: f32 },
    Rect { w: f32, h: f32 },
    Point,
}`,
  },
  {
    name: 'Niche optimization',
    code: `use std::num::NonZeroU32;

struct Handles {
    file: Option<Box<u64>>,
    id: Option<NonZeroU32>,
    flag: Option<bool>,
    name: Option<String>,
}`,
  },
  {
    name: 'repr(u8) enum',
    code: `#[repr(u8)]
enum Message {
    Quit = 1,
    Move { x: i32, y: i32 } = 2,
    Write(u16) = 3,
}`,
  },
  {
    name: 'Packed and aligned',
    code: `#[repr(C, packed)]
struct Header {
    magic: u32,
    kind: u8,
    len: u64,
}

#[repr(C, align(64))]
struct CacheLine {
    header: Header,
    counter: u64,
}`,
  },
  {
    name: 'Generics and const generics',
    code: `struct Ring<T, const N: usize> {
    head: u16,
    items: [T; N],
    full: bool,
}

struct Buffers {
    small: Ring<u8, 16>,
    wide: Ring<u64, 4>,
}`,
  },
];
