/**
 * Zig's std.sort.pdq (lib/std/sort/pdq.zig, with insertionContext and heapContext from
 * lib/std/sort.zig), as of Zig 0.17, ported step for step. The compiler sorts struct fields with
 * it (`mem.sortUnstable` in Sema.type_resolution.resolveStructLayout), and the sort is unstable,
 * so which of several equally aligned fields comes first is whatever this algorithm leaves.
 */
export function pdqSort<T>(items: T[], lessThan: (a: T, b: T) => boolean): void {
  const ctx: Context = {
    lessThan: (a, b) => lessThan(items[a]!, items[b]!),
    swap: (a, b) => {
      const t = items[a]!;
      items[a] = items[b]!;
      items[b] = t;
    },
  };
  pdqContext(0, items.length, ctx);
}

interface Context {
  lessThan(a: number, b: number): boolean;
  swap(a: number, b: number): void;
}

/** std.math.log2_int */
const log2Int = (n: number) => Math.floor(Math.log2(n));
const ceilPowerOfTwo = (n: number) => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};

function insertionContext(a: number, b: number, ctx: Context): void {
  for (let i = a + 1; i < b; i++) {
    for (let j = i; j > a && ctx.lessThan(j, j - 1); j--) ctx.swap(j, j - 1);
  }
}

/** Insertion sort that relies on items[a - 1] being no greater than any item of [a, b). */
function unguardedInsertionContext(a: number, b: number, ctx: Context): void {
  for (let i = a + 1; i < b; i++) {
    for (let j = i; ctx.lessThan(j, j - 1); j--) ctx.swap(j, j - 1);
  }
}

function siftDown(a: number, target: number, b: number, ctx: Context): void {
  let cur = target;
  for (;;) {
    let child = (cur - a) * 2 + a + 1;
    if (!(child < b)) break;
    const next = child + 1;
    if (next < b && ctx.lessThan(child, next)) child = next;
    if (ctx.lessThan(child, cur)) break;
    ctx.swap(child, cur);
    cur = child;
  }
}

function heapContext(a: number, b: number, ctx: Context): void {
  let i = a + Math.floor((b - a) / 2);
  while (i > a) {
    i -= 1;
    siftDown(a, i, b, ctx);
  }
  i = b;
  while (i > a) {
    i -= 1;
    ctx.swap(a, i);
    siftDown(a, a, i, ctx);
  }
}

type Hint = 'increasing' | 'decreasing' | 'unknown';

interface Range {
  a: number;
  b: number;
  limit: number;
  leftmost: boolean;
  balanced: boolean;
  partitioned: boolean;
}

function pdqContext(a: number, b: number, ctx: Context): void {
  const maxInsertion = 24;
  const maxLimit = b > a ? log2Int(b - a) : 0;
  const stack: Range[] = [];
  let range: Range = { a, b, limit: maxLimit, leftmost: true, balanced: true, partitioned: true };

  for (;;) {
    for (;;) {
      const len = range.b - range.a;
      if (len <= maxInsertion) {
        if (range.leftmost) insertionContext(range.a, range.b, ctx);
        else unguardedInsertionContext(range.a, range.b, ctx);
        break;
      }
      if (range.limit === 0) {
        heapContext(range.a, range.b, ctx);
        break;
      }
      if (!range.balanced) {
        breakPatterns(range.a, range.b, ctx);
        range.limit -= 1;
      }
      const chosen = chosePivot(range.a, range.b, ctx);
      let pivot = chosen.pivot;
      let hint = chosen.hint;
      if (hint === 'decreasing') {
        reverseRange(range.a, range.b, ctx);
        pivot = range.b - 1 - (pivot - range.a);
        hint = 'increasing';
      }
      if (range.balanced && range.partitioned && hint === 'increasing') {
        if (partialInsertionSort(range.a, range.b, ctx)) break;
      }
      if (range.a > a && !ctx.lessThan(range.a - 1, pivot)) {
        range.a = partitionEqual(range.a, range.b, pivot, ctx);
        continue;
      }
      const part = partition(range.a, range.b, pivot, ctx);
      const mid = part.pivot;
      const leftLen = mid - range.a;
      const rightLen = range.b - (mid + 1);
      const balancedThreshold = Math.floor(len / 8);
      const leftIsSmaller = leftLen < rightLen;
      const wasBalanced = (leftIsSmaller ? leftLen : rightLen) >= balancedThreshold;
      // The larger range waits on the stack; the smaller one is sorted now.
      stack.push({
        a: leftIsSmaller ? mid + 1 : range.a,
        b: leftIsSmaller ? range.b : mid,
        limit: range.limit,
        leftmost: leftIsSmaller ? false : range.leftmost,
        balanced: wasBalanced,
        partitioned: part.already,
      });
      range = {
        a: leftIsSmaller ? range.a : mid + 1,
        b: leftIsSmaller ? mid : range.b,
        limit: range.limit,
        leftmost: leftIsSmaller ? range.leftmost : false,
        balanced: true,
        partitioned: part.already,
      };
    }
    const top = stack.pop();
    if (!top) break;
    range = top;
  }
}

/** Block partition: the items less than the pivot, then the rest. */
function partition(a: number, b: number, pivot: number, ctx: Context): { pivot: number; already: boolean } {
  ctx.swap(a, pivot);
  let i = a + 1;
  let j = b - 1;
  while (i <= j && ctx.lessThan(i, a)) i += 1;
  while (i <= j && !ctx.lessThan(j, a)) j -= 1;
  if (i > j) {
    ctx.swap(j, a);
    return { pivot: j, already: true };
  }
  ctx.swap(i, j);
  i += 1;
  j -= 1;

  const blockSize = 64;
  const offsetsL: number[] = new Array(blockSize).fill(0);
  const offsetsR: number[] = new Array(blockSize).fill(0);
  let offsetsLBase = i;
  let offsetsRBase = j;
  let numL = 0;
  let numR = 0;
  let startL = 0;
  let startR = 0;

  while (i <= j) {
    const numUnknown = j + 1 - i;
    const leftSplit = numL === 0 ? Math.min(blockSize, numR === 0 ? Math.floor(numUnknown / 2) : numUnknown) : 0;
    const rightSplit = numR === 0 ? Math.min(blockSize, numUnknown - leftSplit) : 0;
    for (let k = 0; k < leftSplit; k++) {
      offsetsL[numL] = k;
      numL += ctx.lessThan(i + k, a) ? 0 : 1;
    }
    i += leftSplit;
    for (let k = 0; k < rightSplit; k++) {
      offsetsR[numR] = k;
      numR += ctx.lessThan(j - k, a) ? 1 : 0;
    }
    j -= rightSplit;
    const num = Math.min(numL, numR);
    for (let m = 0; m < num; m++) ctx.swap(offsetsLBase + offsetsL[startL + m]!, offsetsRBase - offsetsR[startR + m]!);
    numL -= num;
    numR -= num;
    startL += num;
    startR += num;
    if (numL === 0) {
      startL = 0;
      offsetsLBase = i;
    }
    if (numR === 0) {
      startR = 0;
      offsetsRBase = j;
    }
  }

  if (numL > 0) {
    while (numL > 0) {
      numL -= 1;
      ctx.swap(offsetsLBase + offsetsL[startL + numL]!, j);
      j -= 1;
    }
    i = j + 1;
  }
  if (numR > 0) {
    while (numR > 0) {
      numR -= 1;
      ctx.swap(offsetsRBase - offsetsR[startR + numR]!, i);
      i += 1;
    }
    j = i - 1;
  }
  ctx.swap(j, a);
  return { pivot: j, already: false };
}

function partitionEqual(a: number, b: number, pivot: number, ctx: Context): number {
  ctx.swap(a, pivot);
  let i = a + 1;
  let j = b - 1;
  for (;;) {
    while (i <= j && !ctx.lessThan(a, i)) i += 1;
    while (i <= j && ctx.lessThan(a, j)) j -= 1;
    if (i > j) break;
    ctx.swap(i, j);
    i += 1;
    j -= 1;
  }
  return i;
}

function partialInsertionSort(a: number, b: number, ctx: Context): boolean {
  const maxSteps = 5;
  const shortestShifting = 50;
  let i = a + 1;
  for (let step = 0; step < maxSteps; step++) {
    while (i < b && !ctx.lessThan(i, i - 1)) i += 1;
    if (i === b) return true;
    if (b - a < shortestShifting) return false;
    ctx.swap(i, i - 1);
    if (i - a >= 2) {
      for (let j = i - 1; j > a; j--) {
        if (!ctx.lessThan(j, j - 1)) break;
        ctx.swap(j, j - 1);
      }
    }
    if (b - i >= 2) {
      for (let j = i + 1; j < b; j++) {
        if (!ctx.lessThan(j, j - 1)) break;
        ctx.swap(j, j - 1);
      }
    }
  }
  return false;
}

function breakPatterns(a: number, b: number, ctx: Context): void {
  const len = b - a;
  if (len < 8) return;
  const mask64 = (1n << 64n) - 1n;
  let rand = BigInt(len);
  const modulus = BigInt(ceilPowerOfTwo(len));
  const mid = a + Math.floor(len / 4) * 2;
  for (let i = mid - 1; i <= mid + 1; i++) {
    rand ^= (rand << 13n) & mask64;
    rand ^= rand >> 7n;
    rand ^= (rand << 17n) & mask64;
    let other = Number(rand & (modulus - 1n));
    if (other >= len) other -= len;
    ctx.swap(i, a + other);
  }
}

function chosePivot(a: number, b: number, ctx: Context): { pivot: number; hint: Hint } {
  const shortestNinther = 50;
  const maxSwaps = 4 * 3;
  const len = b - a;
  const i = a + Math.floor(len / 4) * 1;
  const j = a + Math.floor(len / 4) * 2;
  const k = a + Math.floor(len / 4) * 3;
  const swaps = { n: 0 };
  if (len >= 8) {
    if (len >= shortestNinther) {
      sort3(i - 1, i, i + 1, swaps, ctx);
      sort3(j - 1, j, j + 1, swaps, ctx);
      sort3(k - 1, k, k + 1, swaps, ctx);
    }
    sort3(i, j, k, swaps, ctx);
  }
  return { pivot: j, hint: swaps.n === 0 ? 'increasing' : swaps.n === maxSwaps ? 'decreasing' : 'unknown' };
}

function sort3(a: number, b: number, c: number, swaps: { n: number }, ctx: Context): void {
  if (ctx.lessThan(b, a)) {
    swaps.n += 1;
    ctx.swap(b, a);
  }
  if (ctx.lessThan(c, b)) {
    swaps.n += 1;
    ctx.swap(c, b);
  }
  if (ctx.lessThan(b, a)) {
    swaps.n += 1;
    ctx.swap(b, a);
  }
}

function reverseRange(a: number, b: number, ctx: Context): void {
  let i = a;
  let j = b - 1;
  while (i < j) {
    ctx.swap(i, j);
    i += 1;
    j -= 1;
  }
}
