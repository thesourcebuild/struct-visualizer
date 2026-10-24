/**
 * Zig's std.sort.pdq (lib/std/sort/pdq.zig, with insertionContext and heapContext from
 * lib/std/sort.zig), ported step for step. The compiler sorts struct fields with it
 * (`mem.sortUnstable` in Sema.type_resolution.resolveStructLayout), and the sort is unstable, so
 * which of several equally aligned fields comes first is whatever this algorithm leaves.
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

const floorPowerOfTwo = (n: number) => {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
};
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

function pdqContext(a: number, b: number, ctx: Context): void {
  const maxInsertion = 24;
  const maxLimit = floorPowerOfTwo(b - a) + 1;
  const stack: { a: number; b: number; limit: number }[] = [];
  let range = { a, b, limit: maxLimit };

  for (;;) {
    let wasBalanced = true;
    let wasPartitioned = true;
    for (;;) {
      const len = range.b - range.a;
      if (len <= maxInsertion) {
        insertionContext(range.a, range.b, ctx);
        break;
      }
      if (range.limit === 0) {
        heapContext(range.a, range.b, ctx);
        break;
      }
      if (!wasBalanced) {
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
      if (wasBalanced && wasPartitioned && hint === 'increasing') {
        if (partialInsertionSort(range.a, range.b, ctx)) break;
      }
      if (range.a > a && !ctx.lessThan(range.a - 1, pivot)) {
        range.a = partitionEqual(range.a, range.b, pivot, ctx);
        continue;
      }
      const part = partition(range.a, range.b, pivot, ctx);
      const mid = part.pivot;
      wasPartitioned = part.already;
      const leftLen = mid - range.a;
      const rightLen = range.b - mid;
      const balancedThreshold = Math.floor(len / 8);
      if (leftLen < rightLen) {
        wasBalanced = leftLen >= balancedThreshold;
        stack.push({ a: range.a, b: mid, limit: range.limit });
        range = { ...range, a: mid + 1 };
      } else {
        wasBalanced = rightLen >= balancedThreshold;
        stack.push({ a: mid + 1, b: range.b, limit: range.limit });
        range = { ...range, b: mid };
      }
    }
    const top = stack.pop();
    if (!top) break;
    range = top;
  }
}

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
  for (;;) {
    while (i <= j && ctx.lessThan(i, a)) i += 1;
    while (i <= j && !ctx.lessThan(j, a)) j -= 1;
    if (i > j) break;
    ctx.swap(i, j);
    i += 1;
    j -= 1;
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
