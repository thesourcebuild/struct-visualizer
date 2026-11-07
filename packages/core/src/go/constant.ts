/**
 * Go constant values, as go/constant represents them (spec: "Constants", "Constant
 * expressions"): booleans, strings, integers of arbitrary precision, and floating-point and
 * complex values that are exact fractions while numerator and denominator stay below 4096 bits,
 * and 512-bit binary floating-point numbers beyond that (go/constant's ratVal and floatVal).
 *
 * The typing rules (untyped kinds, conversions, representability) are in eval.ts.
 */

/** go/constant's maxExp: fractions with parts of this many bits or more become floats. */
const MAX_EXP = 4 << 10;
/** go/constant's prec: the precision of its floats. */
const PREC = 512;

/** An exact fraction num/den (den > 0, reduced), or mant·2^exp rounded to 512 bits. */
export type Real = { exact: true; num: bigint; den: bigint } | { exact: false; mant: bigint; exp: number };

export type ConstValue =
  | { kind: 'bool'; value: boolean }
  /** The string's bytes (UTF-8 for Go source text). */
  | { kind: 'string'; bytes: number[] }
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: Real }
  /** Parts are integers or reals, as go/constant keeps them. */
  | { kind: 'complex'; re: ComplexPart; im: ComplexPart };

export type ComplexPart = { kind: 'int'; value: bigint } | { kind: 'float'; value: Real };

const partReal = (p: ComplexPart): Real => (p.kind === 'int' ? makeRat(p.value, 1n) : p.value);
const partSign = (p: ComplexPart): number => realSign(partReal(p));

export class ConstError extends Error {}

// ------------------------------------------------------------------ bigint helpers

const abs = (x: bigint) => (x < 0n ? -x : x);

export function bitLen(x: bigint): number {
  x = abs(x);
  if (x === 0n) return 0;
  return x.toString(2).length;
}

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

const pow2 = (n: number) => 1n << BigInt(n);

// ------------------------------------------------------------------ reals

/** go/constant's makeRat: a fraction while its parts are small, else a 512-bit float. */
function makeRat(num: bigint, den: bigint): Real {
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den) || 1n;
  num /= g;
  den /= g;
  if (bitLen(num) < MAX_EXP && bitLen(den) < MAX_EXP) return { exact: true, num, den };
  // Without an exponent range a float never overflows.
  return roundFraction(num, den, PREC) as Real;
}

export const ratFromInt = (x: bigint): Real => ({ exact: true, num: x, den: 1n });

/**
 * num/den rounded to nearest-even with `prec` bits (big.Float rounding), as mant·2^exp. With
 * `range`, IEEE-754 limits apply (subnormals, and Infinity above the largest exponent).
 */
function roundFraction(
  num: bigint,
  den: bigint,
  prec: number,
  range?: { emin: number; emax: number },
): { exact: false; mant: bigint; exp: number } | 'inf' {
  if (num === 0n) return { exact: false, mant: 0n, exp: 0 };
  const neg = num < 0n !== den < 0n;
  num = abs(num);
  den = abs(den);
  // Find e with 2^(e-1) <= num/den < 2^e.
  let e = bitLen(num) - bitLen(den);
  const below = (k: number) => (k >= 0 ? num < den << BigInt(k) : num << BigInt(-k) < den);
  if (below(e - 1)) e -= 1;
  else if (!below(e)) e += 1;
  // The value is 1.f × 2^(e-1); with subnormals, never below the smallest normal exponent.
  let bits = prec;
  if (range && e - 1 < range.emin) bits = prec - (range.emin - (e - 1));
  const scale = bits - e; // q = num/den × 2^scale has `bits` bits
  let n = num;
  let d = den;
  if (scale >= 0) n <<= BigInt(scale);
  else d <<= BigInt(-scale);
  let q = n / d;
  const r2 = (n % d) * 2n;
  if (r2 > d || (r2 === d && (q & 1n) === 1n)) q += 1n;
  let exp = -scale;
  if (bits > 0 && q === pow2(bits)) {
    // Rounded up to the next power of two.
    q >>= 1n;
    exp += 1;
  }
  if (range && q !== 0n && bitLen(q) + exp - 1 > range.emax) return 'inf';
  return normalize(neg ? -q : q, exp);
}

function normalize(mant: bigint, exp: number): { exact: false; mant: bigint; exp: number } {
  if (mant === 0n) return { exact: false, mant: 0n, exp: 0 };
  while ((mant & 1n) === 0n) {
    mant >>= 1n;
    exp += 1;
  }
  return { exact: false, mant, exp };
}

/** A float as an exact fraction (only for values that came from a fraction or float64). */
function floatToFraction(x: { mant: bigint; exp: number }): { num: bigint; den: bigint } {
  return x.exp >= 0 ? { num: x.mant << BigInt(x.exp), den: 1n } : { num: x.mant, den: pow2(-x.exp) };
}

/** go/constant's match for reals: a fraction meets a float as a float. */
function asFloat(x: Real): { exact: false; mant: bigint; exp: number } {
  if (!x.exact) return x;
  return roundFraction(x.num, x.den, PREC) as { exact: false; mant: bigint; exp: number };
}

/** mant·2^exp rounded to nearest-even with 512 bits. */
function floatRound(mant: bigint, exp: number): Real {
  const n = bitLen(mant);
  if (n <= PREC) return normalize(mant, exp);
  const drop = n - PREC;
  const neg = mant < 0n;
  let m = abs(mant);
  const rest = m & (pow2(drop) - 1n);
  m >>= BigInt(drop);
  const half = pow2(drop - 1);
  if (rest > half || (rest === half && (m & 1n) === 1n)) m += 1n;
  return normalize(neg ? -m : m, exp + drop);
}

export function realSign(x: Real): number {
  const v = x.exact ? x.num : x.mant;
  return v > 0n ? 1 : v < 0n ? -1 : 0;
}

export function realCompare(x: Real, y: Real): number {
  if (x.exact && y.exact) {
    const l = x.num * y.den;
    const r = y.num * x.den;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  return realSign(realSub(x, y));
}

function realAddSub(x: Real, y: Real, sub: boolean): Real {
  if (x.exact && y.exact) {
    return makeRat(sub ? x.num * y.den - y.num * x.den : x.num * y.den + y.num * x.den, x.den * y.den);
  }
  const a = asFloat(x);
  const b0 = asFloat(y);
  const b = { mant: sub ? -b0.mant : b0.mant, exp: b0.exp };
  if (a.mant === 0n) return normalize(b.mant, b.exp);
  if (b.mant === 0n) return a;
  // When one operand is below half a unit in the 512th place of the other, the sum rounds to
  // the larger one (it already has at most 512 bits).
  const topA = a.exp + bitLen(a.mant);
  const topB = b.exp + bitLen(b.mant);
  if (topB < topA - PREC - 2) return a;
  if (topA < topB - PREC - 2) return normalize(b.mant, b.exp);
  const exp = Math.min(a.exp, b.exp);
  const sum = (a.mant << BigInt(a.exp - exp)) + (b.mant << BigInt(b.exp - exp));
  return floatRound(sum, exp);
}

export const realAdd = (x: Real, y: Real) => realAddSub(x, y, false);
export const realSub = (x: Real, y: Real) => realAddSub(x, y, true);

export function realMul(x: Real, y: Real): Real {
  if (x.exact && y.exact) return makeRat(x.num * y.num, x.den * y.den);
  const a = asFloat(x);
  const b = asFloat(y);
  return floatRound(a.mant * b.mant, a.exp + b.exp);
}

export function realQuo(x: Real, y: Real): Real {
  if (realSign(y) === 0) throw new ConstError('division by zero');
  if (x.exact && y.exact) return makeRat(x.num * y.den, x.den * y.num);
  const a = asFloat(x);
  const b = asFloat(y);
  // Enough quotient bits for 512 significant ones plus rounding; the remainder is sticky.
  const k = PREC + 2 + bitLen(b.mant);
  const n = a.mant << BigInt(k);
  const q = n / b.mant;
  const r = n % b.mant;
  if (r === 0n) return floatRound(q, a.exp - b.exp - k);
  // q has at least 514 bits, so a 1 appended below it is below the rounding position: it only
  // records that the quotient is not exact (a sticky bit) for round-half-even.
  return floatRound(q * 2n + (q < 0n ? -1n : 1n), a.exp - b.exp - k - 1);
}

export const realNeg = (x: Real): Real => (x.exact ? { exact: true, num: -x.num, den: x.den } : { exact: false, mant: -x.mant, exp: x.exp });

/** go/constant's ToInt for a real: its integer value, or undefined. */
export function realToInt(x: Real): bigint | undefined {
  if (x.exact) return x.den === 1n ? x.num : undefined;
  if (x.mant === 0n) return 0n;
  // smallFloat: big.Float's MantExp exponent strictly within ±maxExp.
  const mantExp = x.exp + bitLen(x.mant);
  if (!(-MAX_EXP < mantExp && mantExp < MAX_EXP)) return undefined;
  if (x.exp >= 0) return x.mant << BigInt(x.exp);
  // "If we can get an integer by rounding up or down, assume x is not an integer because of
  // rounding errors in previous computations": try 508 bits toward zero, then away from it.
  const delta = 4;
  for (const away of [false, true]) {
    const r = roundDirected(x.mant, x.exp, PREC - delta, away);
    if (r.exp >= 0) return r.mant << BigInt(r.exp);
  }
  return undefined;
}

function roundDirected(mant: bigint, exp: number, prec: number, away: boolean): { mant: bigint; exp: number } {
  const n = bitLen(mant);
  if (n <= prec) return normalize(mant, exp);
  const drop = n - prec;
  const neg = mant < 0n;
  let m = abs(mant);
  const rest = m & (pow2(drop) - 1n);
  m >>= BigInt(drop);
  if (away && rest !== 0n) m += 1n;
  return normalize(neg ? -m : m, exp + drop);
}

/** The real rounded to an IEEE-754 binary32 or binary64 value, or 'inf' when it overflows. */
export function realToIEEE(x: Real, bits: 32 | 64): Real | 'inf' {
  const prec = bits === 32 ? 24 : 53;
  const range = bits === 32 ? { emin: -126, emax: 127 } : { emin: -1022, emax: 1023 };
  if (!x.exact && x.mant !== 0n) {
    // Far outside the format's range: no need to build the fraction.
    const top = x.exp + bitLen(x.mant);
    if (top > range.emax + 2) return 'inf';
    if (top < range.emin - prec - 2) return ratFromInt(0n);
  }
  const f = x.exact ? x : floatToFraction(x);
  const r = roundFraction(f.num, f.den, prec, range);
  if (r === 'inf') return 'inf';
  // go/constant.MakeFloat64: a float64 value is always a small fraction.
  const back = floatToFraction(r);
  return makeRat(back.num, back.den);
}

export function realToNumber(x: Real): number {
  const r = realToIEEE(x, 64);
  if (r === 'inf') return realSign(x) * Infinity;
  const f = r.exact ? r : floatToFraction(r);
  return Number(f.num) / Number(f.den);
}

// ------------------------------------------------------------------ literals

/** The exact value of a floating-point literal (decimal or hexadecimal). */
export function parseFloatLiteral(text: string): Real {
  const s = text.replace(/_/g, '');
  let mantissa: string;
  let exp10 = 0;
  let exp2 = 0;
  let radix = 10n;
  if (/^0[xX]/.test(s)) {
    const m = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)$/.exec(s)!;
    mantissa = (m[1] ?? '') + (m[2] ?? '');
    exp2 = Number(m[3]) - 4 * (m[2]?.length ?? 0);
    radix = 16n;
  } else {
    const m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s)!;
    mantissa = (m[1] ?? '') + (m[2] ?? '');
    exp10 = Number(m[3] ?? 0) - (m[2]?.length ?? 0);
  }
  const digits = mantissa === '' ? 0n : BigInt(radix === 16n ? `0x${mantissa}` : mantissa);
  if (digits === 0n) return { exact: true, num: 0n, den: 1n };
  const binaryExp = exp2 + bitLen(digits) + exp10 * Math.log2(10);
  // Beyond big.Float's exponent range the literal overflows, and go/constant has no value for it.
  if (Math.abs(binaryExp) > 2 ** 31) throw new ConstError(`malformed constant: ${text}`);
  // The exact fraction needs as many bits as the exponent; past this the calculator stops
  // instead of computing it (go/constant would keep a 512-bit approximation).
  if (Math.abs(binaryExp) > 1 << 20) throw new ConstError(`the constant ${text} is too large for the calculator`);
  let num = digits;
  let den = 1n;
  if (exp10 > 0) num *= 10n ** BigInt(exp10);
  if (exp10 < 0) den *= 10n ** BigInt(-exp10);
  if (exp2 > 0) num <<= BigInt(exp2);
  if (exp2 < 0) den <<= BigInt(-exp2);
  // go/constant (makeFloatFromLiteral): a literal whose binary exponent, as big.Float.MantExp
  // gives it, is within ±maxExp is an exact fraction; any other is a 512-bit float.
  const r = roundFraction(num, den, PREC) as { exact: false; mant: bigint; exp: number };
  const mantExp = r.exp + bitLen(r.mant);
  if (-MAX_EXP < mantExp && mantExp < MAX_EXP) {
    const g = gcd(num, den);
    return { exact: true, num: num / g, den: den / g };
  }
  return r;
}

export function parseIntLiteral(text: string): bigint {
  const s = text.replace(/_/g, '');
  if (/^0[bB]/.test(s)) return BigInt(`0b${s.slice(2)}`);
  if (/^0[oO]/.test(s)) return BigInt(`0o${s.slice(2)}`);
  if (/^0[xX]/.test(s)) return BigInt(s);
  if (/^0[0-7]+$/.test(s)) return BigInt(`0o${s.slice(1)}`);
  return BigInt(s);
}

// ------------------------------------------------------------------ conversions between kinds

export function toReal(v: ConstValue): Real | undefined {
  if (v.kind === 'int') return makeRat(v.value, 1n);
  if (v.kind === 'float') return v.value;
  if (v.kind === 'complex') return partSign(v.im) === 0 ? partReal(v.re) : undefined;
  return undefined;
}

/** go/constant.ToInt: the value as an integer, if it is one. */
export function toInt(v: ConstValue): bigint | undefined {
  if (v.kind === 'int') return v.value;
  if (v.kind === 'float') return realToInt(v.value);
  if (v.kind === 'complex') return partSign(v.im) === 0 ? realToInt(partReal(v.re)) : undefined;
  return undefined;
}

export function toComplex(v: ConstValue): { re: Real; im: Real } | undefined {
  if (v.kind === 'complex') return { re: partReal(v.re), im: partReal(v.im) };
  const re = toReal(v);
  return re && { re, im: ratFromInt(0n) };
}

// ------------------------------------------------------------------ formatting

/** The value as go/constant's String prints it (for messages). */
export function formatConst(v: ConstValue): string {
  switch (v.kind) {
    case 'bool':
      return String(v.value);
    case 'string': {
      // Quoted: printable ASCII as is, any other byte escaped.
      const shown = v.bytes.length > 72 ? v.bytes.slice(0, 69) : v.bytes;
      const text = shown
        .map((b) => (b === 0x22 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`))
        .join('');
      return `"${text}${shown.length < v.bytes.length ? '...' : ''}"`;
    }
    case 'int':
      return v.value.toString();
    case 'float':
      return formatReal(v.value);
    case 'complex':
      return `(${formatReal(partReal(v.re))} + ${formatReal(partReal(v.im))}i)`;
  }
}

function formatReal(x: Real): string {
  if (x.exact && x.den === 1n) return x.num.toString();
  const n = realToNumber(x);
  return Number.isFinite(n) ? String(Number(n.toPrecision(6))) : n > 0 ? '1e+308+' : '-1e+308-';
}
