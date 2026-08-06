/**
 * Timing-safe string comparison (XOR-fold over the longer input).
 *
 * Comparing credentials with `!==` leaks the first differing byte position
 * (and length) through early exit. This helper always iterates over the
 * longer of the two inputs and folds every byte into one accumulator, so the
 * comparison cost does not reveal where (or whether) the inputs differ.
 * Length differences are encoded into the accumulator as a non-zero
 * difference while still scanning the full longer input.
 */
export function timingSafeEqual(expected: string, actual: string): boolean {
  const a = new TextEncoder().encode(actual);
  const b = new TextEncoder().encode(expected);
  const length = Math.max(a.length, b.length);
  let difference = a.length === b.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}
