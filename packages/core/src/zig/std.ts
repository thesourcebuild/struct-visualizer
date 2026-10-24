/**
 * The part of Zig 0.16's standard library that commonly appears in structs, written as the std
 * sources define it (lib/std/...), so the engine lays it out by the ordinary rules. Methods are
 * left out; function pointer types keep their arity but not every parameter type, which does not
 * change a pointer's layout. `@import("std")` is this file's root.
 *
 * tests/zig-compiler.test.ts checks every type here against the compiler on every target.
 */
export const ZIG_STD = String.raw`
const builtin = @import("builtin");

pub const debug = struct {
    pub const runtime_safety = switch_mode_safety;
    const switch_mode_safety = builtin.mode == .Debug or builtin.mode == .ReleaseSafe;

    pub const SafetyLock = struct {
        state: State = if (runtime_safety) .unlocked else .unknown,
        pub const State = if (runtime_safety) enum { unlocked, locked } else enum { unknown };
    };
};

pub const meta = struct {
    pub fn Int(comptime signedness: anytype, comptime bit_count: u16) type {
        return @Int(signedness, bit_count);
    }
};

pub const math = struct {
    pub fn maxInt(comptime T: type) comptime_int {
        const info = @typeInfo(T);
        const bit_count = info.int.bits;
        if (bit_count == 0) return 0;
        return (1 << (bit_count - @intFromBool(info.int.signedness == .signed))) - 1;
    }
    pub fn minInt(comptime T: type) comptime_int {
        const info = @typeInfo(T);
        const bit_count = info.int.bits;
        if (info.int.signedness == .unsigned) return 0;
        if (bit_count == 0) return 0;
        return -(1 << (bit_count - 1));
    }
};

pub const mem = struct {
    pub const Allocator = struct {
        ptr: *anyopaque,
        vtable: *const VTable,

        pub const VTable = struct {
            alloc: *const fn (*anyopaque, usize, Alignment, usize) ?[*]u8,
            resize: *const fn (*anyopaque, []u8, Alignment, usize, usize) bool,
            remap: *const fn (*anyopaque, []u8, Alignment, usize, usize) ?[*]u8,
            free: *const fn (*anyopaque, []u8, Alignment, usize) void,
        };
    };
    pub const Alignment = enum(@Int(.unsigned, smallestBits(@bitSizeOf(usize) - 1))) {
        @"1", @"2", @"4", @"8", @"16", @"32", @"64", _,
    };
    fn smallestBits(comptime max: comptime_int) comptime_int {
        if (max < 2) return 1;
        if (max < 4) return 2;
        if (max < 8) return 3;
        if (max < 16) return 4;
        if (max < 32) return 5;
        if (max < 64) return 6;
        return 7;
    }
};

pub const array_list = struct {
    pub fn Aligned(comptime T: type, comptime alignment: anytype) type {
        _ = alignment;
        return struct {
            items: []T = &[_]T{},
            capacity: usize = 0,
        };
    }
    pub fn Managed(comptime T: type) type {
        return AlignedManaged(T, null);
    }
    pub fn AlignedManaged(comptime T: type, comptime alignment: anytype) type {
        _ = alignment;
        return struct {
            items: []T,
            capacity: usize,
            allocator: mem.Allocator,
        };
    }
};

pub fn ArrayList(comptime T: type) type {
    return array_list.Aligned(T, null);
}
pub const ArrayListUnmanaged = ArrayList;
pub const ArrayListAligned = array_list.Aligned;
pub const ArrayListAlignedUnmanaged = array_list.Aligned;

pub const hash_map = struct {
    pub const default_max_load_percentage = 80;

    pub fn AutoContext(comptime K: type) type {
        _ = K;
        return struct {};
    }
    pub const StringContext = struct {};

    pub fn AutoHashMap(comptime K: type, comptime V: type) type {
        return HashMap(K, V, AutoContext(K), default_max_load_percentage);
    }
    pub fn AutoHashMapUnmanaged(comptime K: type, comptime V: type) type {
        return HashMapUnmanaged(K, V, AutoContext(K), default_max_load_percentage);
    }
    pub fn StringHashMap(comptime V: type) type {
        return HashMap([]const u8, V, StringContext, default_max_load_percentage);
    }
    pub fn StringHashMapUnmanaged(comptime V: type) type {
        return HashMapUnmanaged([]const u8, V, StringContext, default_max_load_percentage);
    }

    pub fn HashMap(comptime K: type, comptime V: type, comptime Context: type, comptime max_load_percentage: u64) type {
        return struct {
            unmanaged: Unmanaged,
            allocator: mem.Allocator,
            ctx: Context,

            pub const Unmanaged = HashMapUnmanaged(K, V, Context, max_load_percentage);
        };
    }

    pub fn HashMapUnmanaged(comptime K: type, comptime V: type, comptime Context: type, comptime max_load_percentage: u64) type {
        _ = K;
        _ = V;
        _ = Context;
        _ = max_load_percentage;
        return struct {
            metadata: ?[*]Metadata = null,
            size: Size = 0,
            available: Size = 0,
            pointer_stability: debug.SafetyLock = .{},

            pub const Size = u32;
            const Metadata = packed struct {
                fingerprint: u7 = 0,
                used: u1 = 0,
            };
        };
    }
};

pub const AutoHashMap = hash_map.AutoHashMap;
pub const AutoHashMapUnmanaged = hash_map.AutoHashMapUnmanaged;
pub const StringHashMap = hash_map.StringHashMap;
pub const StringHashMapUnmanaged = hash_map.StringHashMapUnmanaged;
pub const HashMap = hash_map.HashMap;
pub const HashMapUnmanaged = hash_map.HashMapUnmanaged;

pub fn MultiArrayList(comptime T: type) type {
    _ = T;
    return struct {
        bytes: [*]u8 = undefined,
        len: usize = 0,
        capacity: usize = 0,
    };
}

pub const atomic = struct {
    pub fn Value(comptime T: type) type {
        return extern struct {
            raw: T,
        };
    }
};

pub const Io = struct {
    pub const Mutex = extern struct {
        state: atomic.Value(State),

        pub const State = enum(u32) {
            unlocked,
            locked_once,
            contended,
        };
    };

    pub const Condition = struct {
        state: atomic.Value(State),
        epoch: atomic.Value(u32),

        const State = packed struct(u32) {
            waiters: u16,
            signals: u16,
        };
    };

    pub const Semaphore = struct {
        mutex: Mutex = .init,
        cond: Condition = .init,
        permits: usize = 0,
    };

    pub const RwLock = struct {
        state: usize,
        mutex: Mutex,
        semaphore: Semaphore,
    };

    pub const Writer = struct {
        vtable: *const VTable,
        buffer: []u8,
        end: usize = 0,

        pub const VTable = struct {
            drain: *const fn (*Writer, []const []const u8, usize) anyerror!usize,
            sendFile: *const fn (*Writer, *anyopaque, usize, usize) anyerror!usize,
            flush: *const fn (*Writer) anyerror!void,
            rebase: *const fn (*Writer, usize, usize) anyerror!void,
        };
    };

    pub const Reader = struct {
        vtable: *const VTable,
        buffer: []u8,
        seek: usize,
        end: usize,

        pub const VTable = struct {
            stream: *const fn (*Reader, *Writer, usize) anyerror!usize,
            discard: *const fn (*Reader, usize) anyerror!usize,
            readVec: *const fn (*Reader, [][]u8) anyerror!usize,
            rebase: *const fn (*Reader, usize) anyerror!void,
        };
    };
};

pub const Random = struct {
    ptr: *anyopaque,
    fillFn: *const fn (ptr: *anyopaque, buf: []u8) void,
};

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

pub fn PriorityQueue(comptime T: type, comptime Context: type, comptime compareFn: anytype) type {
    _ = compareFn;
    return struct {
        items: []T,
        cap: usize,
        context: Context,
    };
}

pub const bit_set = struct {
    pub fn StaticBitSet(comptime size: usize) type {
        if (size <= @bitSizeOf(usize)) {
            return IntegerBitSet(size);
        } else {
            return ArrayBitSet(usize, size);
        }
    }

    pub fn IntegerBitSet(comptime size: u16) type {
        return packed struct(@Int(.unsigned, size)) {
            mask: MaskInt = 0,

            pub const MaskInt = @Int(.unsigned, size);
        };
    }

    pub fn ArrayBitSet(comptime MaskIntType: type, comptime size: usize) type {
        const mask_len = @bitSizeOf(MaskIntType);
        const num_masks = (size + mask_len - 1) / mask_len;
        return extern struct {
            masks: [num_masks]MaskIntType,

            pub const MaskInt = MaskIntType;
        };
    }
};

pub const StaticBitSet = bit_set.StaticBitSet;

pub const enums = struct {
    pub fn EnumSet(comptime E: type) type {
        return struct {
            bits: BitSet = BitSet.initEmpty(),

            const BitSet = StaticBitSet(@typeInfo(E).@"enum".fields.len);
        };
    }

    pub fn EnumArray(comptime E: type, comptime V: type) type {
        return struct {
            values: [@typeInfo(E).@"enum".fields.len]V,
        };
    }
};

pub const EnumSet = enums.EnumSet;
pub const EnumArray = enums.EnumArray;
`;
