export const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  let remainder = right < 0n ? -right : right;
  let divisor = left < 0n ? -left : left;
  while (remainder !== 0n) [divisor, remainder] = [remainder, divisor % remainder];
  return divisor;
};
