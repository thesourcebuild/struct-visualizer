/**
 * Standard-library types that commonly appear in structs, written the way core, alloc and std
 * define them (fields that only matter to the type system, such as allocators and markers, are
 * the zero-size types they really are). Layout and niches then follow from the ordinary rules:
 * NonNull's valid range gives Box, Vec and Option<Box<T>> their niches, Vec's capacity is
 * limited to isize::MAX, Duration's nanoseconds to 999_999_999, and UnsafeCell hides niches.
 *
 * tests/rust-compiler.test.ts checks these against rustc.
 */
export const RUST_PRELUDE = `
// ---- core::marker, core::ptr, core::cell
pub struct PhantomData<T: ?Sized>;
pub struct PhantomPinned;

#[repr(transparent)]
#[rustc_layout_scalar_valid_range_start(1)]
pub struct NonNull<T: ?Sized> { pointer: *const T }

#[repr(transparent)]
pub struct Unique<T: ?Sized> { pointer: NonNull<T>, _marker: PhantomData<T> }

#[lang = "unsafe_cell"]
#[repr(transparent)]
pub struct UnsafeCell<T: ?Sized> { value: T }

#[repr(transparent)]
pub struct Cell<T: ?Sized> { value: UnsafeCell<T> }

pub struct RefCell<T: ?Sized> { borrow: Cell<isize>, value: UnsafeCell<T> }

#[repr(transparent)]
pub struct OnceCell<T> { inner: UnsafeCell<Option<T>> }

#[repr(transparent)]
pub struct ManuallyDrop<T: ?Sized> { value: T }

#[repr(transparent)]
pub union MaybeUninit<T> { uninit: (), value: ManuallyDrop<T> }

#[repr(transparent)]
pub struct Pin<Ptr> { pointer: Ptr }

#[repr(transparent)]
pub struct Wrapping<T>(pub T);

#[repr(transparent)]
pub struct Saturating<T>(pub T);

#[repr(transparent)]
pub struct Reverse<T>(pub T);

// ---- core::num
#[repr(transparent)]
#[rustc_layout_scalar_valid_range_start(1)]
pub struct NonZero<T>(T);
pub type NonZeroU8 = NonZero<u8>;
pub type NonZeroU16 = NonZero<u16>;
pub type NonZeroU32 = NonZero<u32>;
pub type NonZeroU64 = NonZero<u64>;
pub type NonZeroU128 = NonZero<u128>;
pub type NonZeroUsize = NonZero<usize>;
pub type NonZeroI8 = NonZero<i8>;
pub type NonZeroI16 = NonZero<i16>;
pub type NonZeroI32 = NonZero<i32>;
pub type NonZeroI64 = NonZero<i64>;
pub type NonZeroI128 = NonZero<i128>;
pub type NonZeroIsize = NonZero<isize>;

// ---- core::option, core::result, core::cmp, core::ops
pub enum Option<T> { None, Some(T) }
pub enum Result<T, E> { Ok(T), Err(E) }
pub enum Infallible {}

#[repr(i8)]
pub enum Ordering { Less = -1, Equal = 0, Greater = 1 }

pub struct Range<Idx> { pub start: Idx, pub end: Idx }
pub struct RangeInclusive<Idx> { start: Idx, end: Idx, exhausted: bool }

// ---- core::time
#[repr(transparent)]
#[rustc_layout_scalar_valid_range_start(0)]
#[rustc_layout_scalar_valid_range_end(999_999_999)]
struct Nanoseconds(u32);

pub struct Duration { secs: u64, nanos: Nanoseconds }

// ---- core::sync::atomic
#[repr(C, align(1))] pub struct AtomicBool { v: UnsafeCell<u8> }
#[repr(C, align(1))] pub struct AtomicU8 { v: UnsafeCell<u8> }
#[repr(C, align(1))] pub struct AtomicI8 { v: UnsafeCell<i8> }
#[repr(C, align(2))] pub struct AtomicU16 { v: UnsafeCell<u16> }
#[repr(C, align(2))] pub struct AtomicI16 { v: UnsafeCell<i16> }
#[repr(C, align(4))] pub struct AtomicU32 { v: UnsafeCell<u32> }
#[repr(C, align(4))] pub struct AtomicI32 { v: UnsafeCell<i32> }
#[repr(C, align(8))] pub struct AtomicU64 { v: UnsafeCell<u64> }
#[repr(C, align(8))] pub struct AtomicI64 { v: UnsafeCell<i64> }
#[repr(C)] pub struct AtomicUsize { v: UnsafeCell<usize>, _align: [usize; 0] }
#[repr(C)] pub struct AtomicIsize { v: UnsafeCell<isize>, _align: [usize; 0] }
#[repr(C)] pub struct AtomicPtr<T> { p: UnsafeCell<*mut T>, _align: [usize; 0] }

// ---- alloc
pub struct Global;

#[repr(transparent)]
#[rustc_layout_scalar_valid_range_start(0)]
#[rustc_layout_scalar_valid_range_end(isize::MAX as usize)]
struct UsizeNoHighBit(usize);

struct RawVecInner { ptr: Unique<u8>, cap: UsizeNoHighBit, alloc: Global }
pub struct RawVec<T> { inner: RawVecInner, _marker: PhantomData<T> }
pub struct Vec<T> { buf: RawVec<T>, len: usize }
pub struct String { vec: Vec<u8> }
pub struct VecDeque<T> { head: usize, len: usize, buf: RawVec<T> }
pub struct BinaryHeap<T> { data: Vec<T> }

pub struct Box<T: ?Sized>(Unique<T>, Global);

struct RcInner<T: ?Sized> { strong: Cell<usize>, weak: Cell<usize>, value: T }
pub struct Rc<T: ?Sized> { ptr: NonNull<RcInner<T>>, phantom: PhantomData<RcInner<T>>, alloc: Global }
pub struct Arc<T: ?Sized> { ptr: NonNull<RcInner<T>>, phantom: PhantomData<RcInner<T>>, alloc: Global }
pub struct Weak<T: ?Sized> { ptr: NonNull<RcInner<T>>, alloc: Global }

struct BTreeRoot { height: usize, node: NonNull<u8> }
pub struct BTreeMap<K, V> { root: Option<BTreeRoot>, length: usize, alloc: ManuallyDrop<Global>, _marker: PhantomData<Box<(K, V)>> }
pub struct BTreeSet<T> { map: BTreeMap<T, ()> }

pub struct LinkedList<T> { head: Option<NonNull<T>>, tail: Option<NonNull<T>>, len: usize, alloc: Global }

// Cow<B> (Borrowed(&B) or Owned(B::Owned)) is built by the engine: B::Owned needs trait resolution.

// ---- std (hashbrown)
pub struct RandomState { k0: u64, k1: u64 }
struct RawTableInner { bucket_mask: usize, ctrl: NonNull<u8>, growth_left: usize, items: usize }
struct RawTable<T> { table: RawTableInner, alloc: Global, marker: PhantomData<T> }
struct HashbrownMap<K, V, S> { hash_builder: S, table: RawTable<(K, V)> }
pub struct HashMap<K, V, S = RandomState> { base: HashbrownMap<K, V, S> }
pub struct HashSet<T, S = RandomState> { base: HashbrownMap<T, (), S> }
`;

/** Prelude types that exist only in std (not in core/alloc), for no_std targets. */
export const STD_ONLY = new Set(['HashMap', 'HashSet', 'RandomState']);
