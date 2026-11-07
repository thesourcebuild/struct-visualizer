/**
 * The part of Zig 0.17's standard library that commonly appears in structs, transcribed from its
 * sources (lib/std/...): each type's fields, and the declarations they and its compile-time
 * checks refer to, as std writes them. Other methods and declarations are left out. Each std file
 * is a struct of the same name here (`mem.Allocator` for mem/Allocator.zig), and `@import("std")`
 * is this file's root.
 *
 * Not here: types whose definition needs comptime the engine does not run, such as EnumSet and
 * EnumArray (std.enums.EnumIndexer sorts the fields in a loop). Using one is an error.
 *
 * tests/zig-compiler.test.ts checks every type here against the compiler on every target.
 */
export const ZIG_STD = String.raw`
const std = @import("std");

// ---- lang.zig (std.builtin is a deprecated name for it)
pub const builtin = lang;
pub const lang = struct {
    pub const OptimizeMode = Optimize;

    pub const Optimize = enum {
        debug,
        safe,
        fast,
        small,

        pub const Debug: @This() = .debug;
        pub const ReleaseSafe: @This() = .safe;
        pub const ReleaseFast: @This() = .fast;
        pub const ReleaseSmall: @This() = .small;

        pub fn runtimeSafety(o: @This()) bool {
            return switch (o) {
                .debug, .safe => true,
                .fast, .small => false,
            };
        }
    };

    pub const AddressSpace = enum(u5) {
        generic,
        gs,
        fs,
        ss,
        far,
        global,
        constant,
        param,
        shared,
        local,
        private,
        input,
        output,
        uniform,
        push_constant,
        storage_buffer,
        physical_storage_buffer,
        flash,
        flash1,
        flash2,
        flash3,
        flash4,
        flash5,
        cog,
        hub,
        lut,
        externref,
        funcref,
    };

    pub const Signedness = enum(u1) {
        signed,
        unsigned,
    };

    pub const Type = union(enum) {
        type,
        void,
        bool,
        noreturn,
        int: Int,
        float: Float,
        pointer: Pointer,
        array: Array,
        @"struct": Struct,
        comptime_float,
        comptime_int,
        undefined,
        null,
        optional: Optional,
        error_union: ErrorUnion,
        error_set: ErrorSet,
        @"enum": Enum,
        @"union": Union,
        @"fn": Fn,
        @"opaque": Opaque,
        frame: Frame,
        @"anyframe": AnyFrame,
        vector: Vector,
        enum_literal,
        spirv: Spirv,

        pub const Int = struct {
            signedness: Signedness,
            bits: u16,
        };
        pub const Float = struct {
            bits: u16,
        };
        pub const Pointer = struct {
            size: Size,
            attrs: Attributes,
            child: type,
            sentinel_ptr: ?*const anyopaque,

            pub const Size = enum(u2) {
                one,
                many,
                slice,
                c,
            };

            pub const Attributes = struct {
                @"const": bool = false,
                @"volatile": bool = false,
                @"allowzero": bool = false,
                @"addrspace": ?AddressSpace = null,
                @"align": ?usize = null,
            };
        };
        pub const Array = struct {
            len: comptime_int,
            child: type,
            sentinel_ptr: ?*const anyopaque,
        };
        pub const ContainerLayout = enum(u2) {
            auto,
            @"extern",
            @"packed",
        };
        pub const Struct = struct {
            is_tuple: bool,
            layout: ContainerLayout,
            backing_integer: ?type,
            field_names: []const [:0]const u8,
            field_types: []const type,
            field_attrs: []const FieldAttributes,
            decl_names: []const [:0]const u8,

            pub const FieldAttributes = struct {
                @"comptime": bool = false,
                @"align": ?usize = null,
                default_value_ptr: ?*const anyopaque = null,
            };
        };
        pub const Optional = struct {
            child: type,
        };
        pub const ErrorUnion = struct {
            error_set: type,
            payload: type,
        };
        pub const ErrorSet = struct {
            error_names: ?[]const [:0]const u8,
        };
        pub const Enum = struct {
            tag_type: type,
            mode: Mode,
            field_names: []const [:0]const u8,
            field_values: []const comptime_int,
            decl_names: []const [:0]const u8,

            pub const Mode = enum { exhaustive, nonexhaustive };
        };
        pub const Union = struct {
            layout: ContainerLayout,
            tag_type: ?type,
            backing_integer: ?type,
            field_names: []const [:0]const u8,
            field_types: []const type,
            field_attrs: []const FieldAttributes,
            decl_names: []const [:0]const u8,

            pub const FieldAttributes = struct {
                @"align": ?usize = null,
            };
        };
        pub const Fn = struct {
            attrs: Attributes,
            is_generic: bool,
            return_type: ?type,
            param_types: []const ?type,
            param_attrs: []const ParamAttributes,

            pub const ParamAttributes = struct {
                @"noalias": bool = false,
            };

            pub const Attributes = struct {
                @"callconv": CallingConvention = .auto,
                varargs: bool = false,
            };
        };
        pub const Spirv = union(enum(u2)) {
            sampler,
            image: Image,
            sampled_image: type,
            runtime_array: type,

            pub const Image = struct {
                usage: Usage,
                format: Format,
                dim: Dimensionality,
                depth: Depth,
                access: Access,
                arrayed: bool,
                multisampled: bool,

                pub const Usage = union(enum(u2)) {
                    unknown: type,
                    sampled: type,
                    storage: type,
                };

                pub const Format = enum(u4) {
                    unknown,
                    rgba32f,
                    rgba32i,
                    rgba32u,
                    rgba16f,
                    rgba16i,
                    rgba16u,
                    rgba8unorm,
                    rgba8snorm,
                    rgba8i,
                    rgba8u,
                    r32f,
                    r32i,
                    r32u,
                };

                pub const Dimensionality = enum(u2) {
                    @"1d",
                    @"2d",
                    @"3d",
                    cube,
                };

                pub const Depth = enum(u2) { unknown, depth, not_depth };

                pub const Access = enum(u2) { unknown, read_only, write_only, read_write };
            };
        };
        pub const Opaque = struct {
            decl_names: []const [:0]const u8,
        };
        pub const Frame = struct {
            function: *const anyopaque,
        };
        pub const AnyFrame = struct {
            child: ?type,
        };
        pub const Vector = struct {
            len: comptime_int,
            child: type,
        };
    };
};

// ---- Target.zig: what @import("builtin") describes the target with
pub const Target = struct {
    pub const Os = struct {
        pub const Tag = enum {
            freestanding,
            other,

            contiki,
            fuchsia,
            hermit,
            managarm,

            haiku,
            hurd,
            illumos,
            linux,
            plan9,
            rtems,
            serenity,

            dragonfly,
            freebsd,
            netbsd,
            openbsd,

            driverkit,
            ios,
            maccatalyst,
            macos,
            tvos,
            visionos,
            watchos,

            windows,
            uefi,

            @"3ds",
            wiiu,
            @"switch",
            gba,

            psx,
            ps3,
            ps4,
            ps5,
            psp,
            vita,

            emscripten,
            wasi,

            amdhsa,
            amdpal,
            cuda,
            mesa3d,
            nvcl,
            opencl,
            opengl,
            vulkan,

            tios,

            ashetos,
        };
    };

    pub const Abi = enum {
        none,
        gnu,
        gnuabin32,
        gnuabi64,
        gnueabi,
        gnueabihf,
        gnuf32,
        gnusf,
        gnux32,
        eabi,
        eabihf,
        abin32,
        x32,
        ilp32,
        android,
        androideabi,
        musl,
        muslabin32,
        muslabi64,
        musleabi,
        musleabihf,
        muslf32,
        muslsf,
        muslx32,
        msvc,
        itanium,
        simulator,
        ohos,
        ohoseabi,
        call0,
    };

    pub const Cpu = struct {
        pub const Arch = enum {
            aarch64,
            aarch64_be,
            alpha,
            amdgcn,
            arc,
            arceb,
            arm,
            armeb,
            avr,
            bpfeb,
            bpfel,
            csky,
            ez80,
            hexagon,
            hppa,
            hppa64,
            kalimba,
            kvx,
            lanai,
            loongarch32,
            loongarch64,
            m68k,
            m88k,
            microblaze,
            microblazeel,
            mips,
            mipsel,
            mips64,
            mips64el,
            msp430,
            nvptx,
            nvptx64,
            or1k,
            powerpc,
            powerpcle,
            powerpc64,
            powerpc64le,
            propeller,
            riscv32,
            riscv32be,
            riscv64,
            riscv64be,
            s390x,
            sh,
            sheb,
            sparc,
            sparc64,
            spork8,
            spirv32,
            spirv64,
            thumb,
            thumbeb,
            ve,
            wasm32,
            wasm64,
            x86_16,
            x86,
            x86_64,
            xcore,
            xtensa,
            xtensaeb,
        };
    };
};

// ---- debug.zig
pub const debug = struct {
    const builtin = @import("builtin");
    const math = std.math;

    pub const runtime_safety = builtin.mode.runtimeSafety();

    pub fn assert(ok: bool) void {
        @disableInstrumentation();
        if (!ok) unreachable; // assertion failure
    }

    pub const SafetyLock = struct {
        state: State = if (runtime_safety) .unlocked else .unknown,

        pub const State = if (runtime_safety) enum(usize) {
            unlocked = 0,
            exclusive = math.maxInt(usize),
            _, // shared lock count
        } else enum { unknown };
    };
};

// ---- meta.zig: std.meta.Int is gone in 0.17 (use @Int).
pub const meta = struct {};

// ---- math.zig
pub const math = struct {
    const assert = std.debug.assert;

    pub fn maxInt(comptime T: type) comptime_int {
        const info = @typeInfo(T).int;
        return (1 << (info.bits - @intFromBool(info.signedness == .signed))) - 1;
    }

    pub fn minInt(comptime T: type) comptime_int {
        const info = @typeInfo(T).int;
        return switch (info.signedness) {
            .unsigned => 0,
            .signed => -(1 << (info.bits - 1)),
        };
    }

    pub fn Log2Int(comptime T: type) type {
        // comptime ceil log2
        if (T == comptime_int) return comptime_int;
        const bits: u16 = @typeInfo(T).int.bits;
        const log2_bits = 16 - @clz(bits - 1);
        return @Int(.unsigned, log2_bits);
    }

    pub fn isPowerOfTwo(int: anytype) bool {
        assert(int > 0);
        return (int & (int - 1)) == 0;
    }

    pub const Order = enum {
        gt,
        lt,
        eq,
    };
};

// ---- mem.zig, mem/Allocator.zig
pub const mem = struct {
    const math = std.math;

    pub const byte_size_in_bits = 8;

    pub const Allocator = struct {
        const Alignment = std.mem.Alignment;

        pub const Error = error{OutOfMemory};
        pub const Log2Align = math.Log2Int(usize);

        ptr: *anyopaque,
        vtable: *const VTable,

        pub const VTable = struct {
            alloc: *const fn (*anyopaque, len: usize, alignment: Alignment, ret_addr: usize) ?[*]u8,
            resize: *const fn (*anyopaque, memory: []u8, alignment: Alignment, new_len: usize, ret_addr: usize) bool,
            remap: *const fn (*anyopaque, memory: []u8, alignment: Alignment, new_len: usize, ret_addr: usize) ?[*]u8,
            free: *const fn (*anyopaque, memory: []u8, alignment: Alignment, ret_addr: usize) void,
        };
    };

    pub const Alignment = enum(math.Log2Int(usize)) {
        @"1" = 0,
        @"2" = 1,
        @"4" = 2,
        @"8" = 3,
        @"16" = 4,
        @"32" = 5,
        @"64" = 6,
        _,

        pub fn toByteUnits(a: Alignment) usize {
            return @as(usize, 1) << @backingInt(a);
        }
    };
};

// ---- array_list.zig
pub const array_list = struct {
    const debug = std.debug;
    const mem = std.mem;
    const Allocator = mem.Allocator;

    pub fn Managed(comptime T: type) type {
        return AlignedManaged(T, null);
    }

    pub fn AlignedManaged(comptime T: type, comptime alignment: ?mem.Alignment) type {
        if (alignment) |a| {
            if (a.toByteUnits() == @alignOf(T)) {
                return AlignedManaged(T, null);
            }
        }
        return struct {
            const Self = @This();
            items: Slice,
            capacity: usize,
            allocator: Allocator,

            pointer_stability: debug.SafetyLock,

            pub const Slice = if (alignment) |a| ([]align(a.toByteUnits()) T) else []T;
        };
    }

    pub fn Aligned(comptime T: type, comptime alignment: ?mem.Alignment) type {
        if (alignment) |a| {
            if (a.toByteUnits() == @alignOf(T)) {
                return Aligned(T, null);
            }
        }
        return struct {
            const Self = @This();
            items: Slice,
            capacity: usize,

            pointer_stability: debug.SafetyLock,

            pub const Slice = if (alignment) |a| ([]align(a.toByteUnits()) T) else []T;
        };
    }
};

pub fn ArrayList(comptime T: type) type {
    return array_list.Aligned(T, null);
}
pub const ArrayListAligned = array_list.Aligned;
pub const ArrayListAlignedUnmanaged = array_list.Aligned;
pub const ArrayListUnmanaged = ArrayList;

// ---- hash_map.zig
pub const hash_map = struct {
    const Allocator = std.mem.Allocator;

    pub fn AutoHashMap(comptime K: type, comptime V: type) type {
        return HashMap(K, V, AutoContext(K), default_max_load_percentage);
    }

    pub fn AutoHashMapUnmanaged(comptime K: type, comptime V: type) type {
        return HashMapUnmanaged(K, V, AutoContext(K), default_max_load_percentage);
    }

    pub fn AutoContext(comptime K: type) type {
        return struct {
            pub const hash = getAutoHashFn(K, @This());
            pub const eql = getAutoEqlFn(K, @This());
        };
    }

    pub fn StringHashMap(comptime V: type) type {
        return HashMap([]const u8, V, StringContext, default_max_load_percentage);
    }

    pub fn StringHashMapUnmanaged(comptime V: type) type {
        return HashMapUnmanaged([]const u8, V, StringContext, default_max_load_percentage);
    }

    pub const StringContext = struct {
        pub fn hash(self: @This(), s: []const u8) u64 {
            _ = self;
            return hashString(s);
        }
        pub fn eql(self: @This(), a: []const u8, b: []const u8) bool {
            _ = self;
            return eqlString(a, b);
        }
    };

    pub const default_max_load_percentage = 80;

    pub fn HashMap(
        comptime K: type,
        comptime V: type,
        comptime Context: type,
        comptime max_load_percentage: u64,
    ) type {
        return struct {
            unmanaged: Unmanaged,
            allocator: Allocator,
            ctx: Context,

            pub const Unmanaged = HashMapUnmanaged(K, V, Context, max_load_percentage);
        };
    }

    pub const HashMapUnmanaged = Custom;
    fn Custom(
        comptime K: type,
        comptime V: type,
        comptime Context: type,
        comptime max_load_percentage: u64,
    ) type {
        if (max_load_percentage <= 0 or max_load_percentage >= 100)
            @compileError("max_load_percentage must be between 0 and 100.");
        return struct {
            const Self = @This();

            metadata: ?[*]Metadata = null,

            size: Size = 0,

            available: Size = 0,

            pointer_stability: std.debug.SafetyLock = .{},

            const minimal_capacity = 8;

            pub const Size = u32;

            pub const Hash = u64;

            pub const Entry = struct {
                key_ptr: *K,
                value_ptr: *V,
            };

            pub const KV = struct {
                key: K,
                value: V,
            };

            const Header = struct {
                values: [*]V,
                keys: [*]K,
                capacity: Size,
            };

            const Metadata = packed struct {
                const FingerPrint = u7;

                const free: FingerPrint = 0;
                const tombstone: FingerPrint = 1;

                fingerprint: FingerPrint = free,
                used: u1 = 0,

                const slot_free: u8 = @bitCast(Metadata{ .fingerprint = free });
                const slot_tombstone: u8 = @bitCast(Metadata{ .fingerprint = tombstone });
            };
        };
    }
};

pub const AutoHashMap = hash_map.AutoHashMap;
pub const AutoHashMapUnmanaged = hash_map.AutoHashMapUnmanaged;
pub const HashMap = hash_map.HashMap;
pub const HashMapUnmanaged = hash_map.HashMapUnmanaged;
pub const StringHashMap = hash_map.StringHashMap;
pub const StringHashMapUnmanaged = hash_map.StringHashMapUnmanaged;

// ---- multi_array_list.zig
pub fn MultiArrayList(comptime T: type) type {
    return struct {
        bytes: [*]u8 = undefined,
        len: usize = 0,
        capacity: usize = 0,
    };
}

// ---- atomic.zig
pub const atomic = struct {
    pub fn Value(comptime T: type) type {
        return extern struct {
            raw: T,

            const Self = @This();
        };
    }
};

// ---- Io.zig, Io/Semaphore.zig, Io/RwLock.zig, Io/Writer.zig, Io/Reader.zig
pub const Io = struct {
    const math = std.math;

    pub const Limit = enum(usize) {
        nothing = 0,
        unlimited = math.maxInt(usize),
        _,
    };

    pub const Mutex = extern struct {
        state: std.atomic.Value(State),

        pub const init: Mutex = .{ .state = .init(.unlocked) };

        pub const State = enum(u32) {
            unlocked,
            locked_once,
            contended,
        };
    };

    pub const Condition = struct {
        state: std.atomic.Value(State),
        epoch: std.atomic.Value(u32),

        const State = packed struct(u32) {
            waiters: u16,
            signals: u16,
        };

        pub const init: Condition = .{
            .state = .init(.{ .waiters = 0, .signals = 0 }),
            .epoch = .init(0),
        };
    };

    pub const Semaphore = struct {
        const Io = std.Io;

        mutex: Io.Mutex = .init,
        cond: Io.Condition = .init,
        permits: usize = 0,
    };

    pub const RwLock = struct {
        const Io = std.Io;

        state: usize,
        mutex: Io.Mutex,
        semaphore: Io.Semaphore,
    };

    pub const Writer = struct {
        const Limit = std.Io.Limit;
        const File = std.Io.File;

        vtable: *const VTable,
        buffer: []u8,
        end: usize = 0,

        pub const VTable = struct {
            drain: *const fn (w: *Writer, data: []const []const u8, splat: usize) Error!usize,
            sendFile: *const fn (
                w: *Writer,
                file_reader: *File.Reader,
                limit: Limit,
            ) FileError!usize = unimplementedSendFile,
            flush: *const fn (w: *Writer) Error!void = defaultFlush,
            rebase: *const fn (w: *Writer, preserve: usize, capacity: usize) Error!void = defaultRebase,
        };

        pub const Error = error{
            WriteFailed,
        };

        pub const FileError = error{
            ReadFailed,
            WriteFailed,
            EndOfStream,
            Unimplemented,
        };
    };

    pub const Reader = struct {
        const Writer = std.Io.Writer;
        const Limit = std.Io.Limit;

        vtable: *const VTable,
        buffer: []u8,
        seek: usize,
        end: usize,

        pub const VTable = struct {
            stream: *const fn (r: *Reader, w: *Writer, limit: Limit) StreamError!usize,
            discard: *const fn (r: *Reader, limit: Limit) Error!usize = defaultDiscard,
            readVec: *const fn (r: *Reader, data: [][]u8) Error!usize = defaultReadVec,
            rebase: *const fn (r: *Reader, capacity: usize) RebaseError!void = defaultRebase,
        };

        pub const StreamError = error{
            ReadFailed,
            WriteFailed,
            EndOfStream,
        };

        pub const Error = error{
            ReadFailed,
            EndOfStream,
        };

        pub const RebaseError = Error;
    };
};

// ---- Random.zig
pub const Random = struct {
    ptr: *anyopaque,
    fillFn: *const fn (ptr: *anyopaque, buf: []u8) void,
};

// ---- DoublyLinkedList.zig, SinglyLinkedList.zig
pub const DoublyLinkedList = struct {
    first: ?*Node = null,
    last: ?*Node = null,

    pub const Node = struct {
        prev: ?*Node = null,
        next: ?*Node = null,
    };
};

pub const SinglyLinkedList = struct {
    first: ?*Node = null,

    pub const Node = struct {
        next: ?*Node = null,
    };
};

// ---- priority_queue.zig
pub fn PriorityQueue(comptime T: type, comptime Context: type, comptime compareFn: fn (context: Context, a: T, b: T) Order) type {
    return struct {
        const Self = @This();

        items: []T,
        cap: usize,
        context: Context,
    };
}
const Order = std.math.Order;

// ---- bit_set.zig
pub const bit_set = struct {
    const Allocator = std.mem.Allocator;

    pub const StaticBitSet = Static;

    pub fn Static(comptime size: usize) type {
        if (size <= @bitSizeOf(usize)) {
            return Integer(size);
        } else {
            return Array(usize, size);
        }
    }

    pub const IntegerBitSet = Integer;

    pub fn Integer(comptime size: u16) type {
        return packed struct(MaskInt) {
            const Self = @This();

            pub const bit_length: usize = size;

            pub const MaskInt = @Int(.unsigned, size);

            pub const ShiftInt = std.math.Log2Int(MaskInt);

            mask: MaskInt,
        };
    }

    pub const ArrayBitSet = Array;

    pub fn Array(comptime MaskIntType: type, comptime size: usize) type {
        const mask_info: std.builtin.Type = @typeInfo(MaskIntType);

        // Make sure the mask int is indeed an int
        if (mask_info != .int) @compileError("Array can only operate on integer masks, but was passed " ++ @typeName(MaskIntType));

        // It must also be unsigned.
        if (mask_info.int.signedness != .unsigned) @compileError("Array requires an unsigned integer mask type, but was passed " ++ @typeName(MaskIntType));

        // And it must not be empty.
        if (MaskIntType == u0)
            @compileError("Array requires a sized integer for its mask int.  u0 does not work.");

        const byte_size = std.mem.byte_size_in_bits;

        // We use shift and truncate to decompose indices into mask indices and bit indices.
        // This operation requires that the mask has an exact power of two number of bits.
        if (!std.math.isPowerOfTwo(@bitSizeOf(MaskIntType))) {
            var desired_bits = std.math.ceilPowerOfTwoAssert(usize, @bitSizeOf(MaskIntType));
            if (desired_bits < byte_size) desired_bits = byte_size;
            const FixedMaskType = @Int(.unsigned, desired_bits);
            @compileError("Array was passed integer type " ++ @typeName(MaskIntType) ++
                ", which is not a power of two.  Please round this up to a power of two integer size (i.e. " ++ @typeName(FixedMaskType) ++ ").");
        }

        // Make sure the integer has no padding bits.
        // Those would be wasteful here and are probably a mistake by the user.
        // This case may be hit with small powers of two, like u4.
        if (@bitSizeOf(MaskIntType) != @sizeOf(MaskIntType) * byte_size) {
            var desired_bits = @sizeOf(MaskIntType) * byte_size;
            desired_bits = std.math.ceilPowerOfTwoAssert(usize, desired_bits);
            const FixedMaskType = @Int(.unsigned, desired_bits);
            @compileError("Array was passed integer type " ++ @typeName(MaskIntType) ++
                ", which contains padding bits.  Please round this up to an unpadded integer size (i.e. " ++ @typeName(FixedMaskType) ++ ").");
        }

        return extern struct {
            const Self = @This();

            pub const bit_length: usize = size;

            pub const MaskInt = MaskIntType;

            pub const ShiftInt = std.math.Log2Int(MaskInt);

            // bits in one mask
            const mask_len = @bitSizeOf(MaskInt);
            // total number of masks
            const num_masks = (size + mask_len - 1) / mask_len;
            // padding bits in the last mask (may be 0)
            const last_pad_bits = mask_len * num_masks - size;
            // Mask of valid bits in the last mask.
            pub const last_item_mask = ~@as(MaskInt, 0) >> last_pad_bits;

            masks: [num_masks]MaskInt,
        };
    }

    pub const DynamicBitSetUnmanaged = Dynamic;

    pub const Dynamic = struct {
        const Self = @This();

        pub const MaskInt = usize;

        pub const ShiftInt = std.math.Log2Int(MaskInt);

        bit_length: usize = 0,

        // std defaults it to empty_masks_ptr, a pointer into a constant array (a slice of
        // [_]MaskInt{ 0, undefined }), which the parser here does not read; defaults do not
        // change the layout.
        masks: [*]MaskInt,
    };

    pub const DynamicBitSet = DynamicManaged;

    pub const DynamicManaged = struct {
        const Self = @This();

        pub const MaskInt = usize;

        pub const ShiftInt = std.math.Log2Int(MaskInt);

        allocator: Allocator,
        unmanaged: Dynamic = .{},
    };
};

pub const DynamicBitSet = bit_set.DynamicBitSet;
pub const DynamicBitSetUnmanaged = bit_set.DynamicBitSetUnmanaged;
pub const StaticBitSet = bit_set.StaticBitSet;

// ---- deque.zig
pub fn Deque(comptime T: type) type {
    return struct {
        const Self = @This();

        buffer: []T,
        head: usize,
        len: usize,
    };
}
`;
