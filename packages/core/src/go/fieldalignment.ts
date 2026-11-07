/**
 * The parts of golang.org/x/tools/go/analysis/passes/fieldalignment (v0.49.0) that decide its
 * suggestion and its message: optimalOrder's comparator, applied with Go's sort.Slice (pdqsort,
 * not stable: equal fields can move), and classSize (the runtime's allocation size classes).
 *
 * fieldalignment sizes types with its own gcSizes, not go/types': see GoLayoutEngine's
 * 'fieldalignment' model.
 */

export interface FieldElem {
  index: number;
  alignof: number;
  sizeof: number;
  ptrdata: number;
}

// ------------------------------------------------------------------ sort.Slice (sort/zsortfunc.go)

interface LessSwap {
  less(i: number, j: number): boolean;
  swap(i: number, j: number): void;
}

type SortedHint = 'unknown' | 'increasing' | 'decreasing';

const bitsLen = (x: number) => (x === 0 ? 0 : 32 - Math.clz32(x));

function insertionSort(data: LessSwap, a: number, b: number): void {
  for (let i = a + 1; i < b; i++) {
    for (let j = i; j > a && data.less(j, j - 1); j--) data.swap(j, j - 1);
  }
}

function siftDown(data: LessSwap, lo: number, hi: number, first: number): void {
  let root = lo;
  for (;;) {
    let child = 2 * root + 1;
    if (child >= hi) return;
    if (child + 1 < hi && data.less(first + child, first + child + 1)) child += 1;
    if (!data.less(first + root, first + child)) return;
    data.swap(first + root, first + child);
    root = child;
  }
}

function heapSort(data: LessSwap, a: number, b: number): void {
  const first = a;
  const lo = 0;
  const hi = b - a;
  for (let i = Math.floor((hi - 1) / 2); i >= 0; i--) siftDown(data, i, hi, first);
  for (let i = hi - 1; i >= 0; i--) {
    data.swap(first, first + i);
    siftDown(data, lo, i, first);
  }
}

function pdqsort(data: LessSwap, a: number, b: number, limit: number): void {
  const maxInsertion = 12;
  let wasBalanced = true;
  let wasPartitioned = true;
  for (;;) {
    const length = b - a;
    if (length <= maxInsertion) {
      insertionSort(data, a, b);
      return;
    }
    if (limit === 0) {
      heapSort(data, a, b);
      return;
    }
    if (!wasBalanced) {
      breakPatterns(data, a, b);
      limit -= 1;
    }
    let [pivot, hint] = choosePivot(data, a, b);
    if (hint === 'decreasing') {
      reverseRange(data, a, b);
      pivot = b - 1 - (pivot - a);
      hint = 'increasing';
    }
    if (wasBalanced && wasPartitioned && hint === 'increasing') {
      if (partialInsertionSort(data, a, b)) return;
    }
    if (a > 0 && !data.less(a - 1, pivot)) {
      a = partitionEqual(data, a, b, pivot);
      continue;
    }
    const [mid, alreadyPartitioned] = partition(data, a, b, pivot);
    wasPartitioned = alreadyPartitioned;
    const leftLen = mid - a;
    const rightLen = b - mid;
    const balanceThreshold = Math.floor(length / 8);
    if (leftLen < rightLen) {
      wasBalanced = leftLen >= balanceThreshold;
      pdqsort(data, a, mid, limit);
      a = mid + 1;
    } else {
      wasBalanced = rightLen >= balanceThreshold;
      pdqsort(data, mid + 1, b, limit);
      b = mid;
    }
  }
}

function partition(data: LessSwap, a: number, b: number, pivot: number): [number, boolean] {
  data.swap(a, pivot);
  let i = a + 1;
  let j = b - 1;
  while (i <= j && data.less(i, a)) i++;
  while (i <= j && !data.less(j, a)) j--;
  if (i > j) {
    data.swap(j, a);
    return [j, true];
  }
  data.swap(i, j);
  i++;
  j--;
  for (;;) {
    while (i <= j && data.less(i, a)) i++;
    while (i <= j && !data.less(j, a)) j--;
    if (i > j) break;
    data.swap(i, j);
    i++;
    j--;
  }
  data.swap(j, a);
  return [j, false];
}

function partitionEqual(data: LessSwap, a: number, b: number, pivot: number): number {
  data.swap(a, pivot);
  let i = a + 1;
  let j = b - 1;
  for (;;) {
    while (i <= j && !data.less(a, i)) i++;
    while (i <= j && data.less(a, j)) j--;
    if (i > j) break;
    data.swap(i, j);
    i++;
    j--;
  }
  return i;
}

function partialInsertionSort(data: LessSwap, a: number, b: number): boolean {
  const maxSteps = 5;
  const shortestShifting = 50;
  let i = a + 1;
  for (let step = 0; step < maxSteps; step++) {
    while (i < b && !data.less(i, i - 1)) i++;
    if (i === b) return true;
    if (b - a < shortestShifting) return false;
    data.swap(i, i - 1);
    if (i - a >= 2) {
      for (let j = i - 1; j >= 1; j--) {
        if (!data.less(j, j - 1)) break;
        data.swap(j, j - 1);
      }
    }
    if (b - i >= 2) {
      for (let j = i + 1; j < b; j++) {
        if (!data.less(j, j - 1)) break;
        data.swap(j, j - 1);
      }
    }
  }
  return false;
}

function breakPatterns(data: LessSwap, a: number, b: number): void {
  const length = b - a;
  if (length < 8) return;
  // xorshift seeded with the length, as a uint64.
  let random = BigInt(length);
  const mask64 = (1n << 64n) - 1n;
  const next = () => {
    random ^= (random << 13n) & mask64;
    random ^= random >> 7n;
    random ^= (random << 17n) & mask64;
    return random;
  };
  const modulus = 2 ** bitsLen(length);
  const start = a + Math.floor(length / 4) * 2 - 1;
  for (let idx = start; idx <= start + 2; idx++) {
    let other = Number(next() & BigInt(modulus - 1));
    if (other >= length) other -= length;
    data.swap(idx, a + other);
  }
}

function choosePivot(data: LessSwap, a: number, b: number): [number, SortedHint] {
  const shortestNinther = 50;
  const maxSwaps = 4 * 3;
  const l = b - a;
  const swaps = { n: 0 };
  let i = a + Math.floor(l / 4) * 1;
  let j = a + Math.floor(l / 4) * 2;
  let k = a + Math.floor(l / 4) * 3;
  if (l >= 8) {
    if (l >= shortestNinther) {
      i = medianAdjacent(data, i, swaps);
      j = medianAdjacent(data, j, swaps);
      k = medianAdjacent(data, k, swaps);
    }
    j = median(data, i, j, k, swaps);
  }
  if (swaps.n === 0) return [j, 'increasing'];
  if (swaps.n === maxSwaps) return [j, 'decreasing'];
  return [j, 'unknown'];
}

function order2(data: LessSwap, a: number, b: number, swaps: { n: number }): [number, number] {
  if (data.less(b, a)) {
    swaps.n += 1;
    return [b, a];
  }
  return [a, b];
}

function median(data: LessSwap, a: number, b: number, c: number, swaps: { n: number }): number {
  [a, b] = order2(data, a, b, swaps);
  [b, c] = order2(data, b, c, swaps);
  [a, b] = order2(data, a, b, swaps);
  return b;
}

const medianAdjacent = (data: LessSwap, a: number, swaps: { n: number }) => median(data, a - 1, a, a + 1, swaps);

function reverseRange(data: LessSwap, a: number, b: number): void {
  for (let i = a, j = b - 1; i < j; i++, j--) data.swap(i, j);
}

/** Go's sort.Slice: pdqsort with the depth limit bits.Len(len). */
export function goSortSlice<T>(x: T[], less: (a: T, b: T) => boolean): void {
  const data: LessSwap = {
    less: (i, j) => less(x[i], x[j]),
    swap: (i, j) => {
      [x[i], x[j]] = [x[j], x[i]];
    },
  };
  pdqsort(data, 0, x.length, bitsLen(x.length));
}

// ------------------------------------------------------------------ fieldalignment

/** optimalOrder's comparator and sort: the field indexes in the suggested order. */
export function fieldAlignmentOrder(elems: readonly FieldElem[]): number[] {
  const sorted = [...elems];
  goSortSlice(sorted, (ei, ej) => {
    // Place zero sized objects before non-zero sized objects.
    const zeroi = ei.sizeof === 0;
    const zeroj = ej.sizeof === 0;
    if (zeroi !== zeroj) return zeroi;
    // Next, place more tightly aligned objects before less tightly aligned objects.
    if (ei.alignof !== ej.alignof) return ei.alignof > ej.alignof;
    // Place pointerful objects before pointer-free objects.
    const noptrsi = ei.ptrdata === 0;
    const noptrsj = ej.ptrdata === 0;
    if (noptrsi !== noptrsj) return noptrsj;
    if (!noptrsi) {
      // If both have pointers, place objects with less trailing non-pointer bytes earlier.
      const traili = ei.sizeof - ei.ptrdata;
      const trailj = ej.sizeof - ej.ptrdata;
      if (traili !== trailj) return traili < trailj;
    }
    // Lastly, order by size.
    if (ei.sizeof !== ej.sizeof) return ei.sizeof > ej.sizeof;
    return false;
  });
  return sorted.map((e) => e.index);
}

/** The runtime's size classes (internal/runtime/gc/sizeclasses.go, Go 1.27). */
const SIZE_CLASSES = [
  0, 8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 288, 320, 352, 384, 416, 448, 480,
  512, 576, 640, 704, 768, 896, 1024, 1152, 1280, 1408, 1536, 1792, 2048, 2304, 2688, 3072, 3200, 3456, 4096, 4864, 5376,
  6144, 6528, 6784, 6912, 8192, 9472, 9728, 10240, 10880, 12288, 13568, 14336, 16384, 18432, 19072, 20480, 21760, 24576,
  27264, 28672, 32768,
];

/**
 * fieldalignment's classSize: cap(bytes.Clone(make([]byte, size))), the allocation size class
 * (runtime roundupsize for a pointer-free object), or -1 above 32 KiB.
 */
export function classSize(size: number): number {
  if (size > 1 << 15) return -1;
  if (size === 0) return 0;
  if (size <= (1 << 15) - 8) return SIZE_CLASSES.find((c) => c >= size)!;
  // A large object: rounded up to the 8 KiB page.
  return Math.ceil(size / 8192) * 8192;
}

/** The diagnostic fieldalignment reports for a struct, or null when it reports none. */
export function fieldAlignmentMessage(
  name: string,
  actual: { size: number; ptrdata: number },
  optimal: { size: number; ptrdata: number },
): string | null {
  if (actual.size !== optimal.size) {
    let message = `${name} has size ${actual.size}`;
    let actualClass = classSize(actual.size);
    if (actualClass === -1) {
      actualClass = actual.size;
      message += ' (uses global allocator)';
    } else if (actualClass !== actual.size) {
      message += ` (allocator size class ${actualClass})`;
    }
    message += ` but the optimal size is ${optimal.size}`;
    let optimalClass = classSize(optimal.size);
    if (optimalClass === -1) {
      optimalClass = optimal.size;
    } else if (optimalClass !== optimal.size) {
      message += ` (allocator size class ${optimalClass})`;
    }
    const wastage = actualClass - optimalClass;
    // Go's integer division truncates toward zero.
    const percentage = Math.trunc((wastage * 100) / actualClass);
    if (percentage > 25) message += ` leading to a waste of ${wastage} bytes (${percentage}%)`;
    return message;
  }
  if (actual.ptrdata !== optimal.ptrdata) {
    return `${name} has ${actual.ptrdata} leading bytes of pointer data but optimal value is ${optimal.ptrdata}`;
  }
  return null;
}
