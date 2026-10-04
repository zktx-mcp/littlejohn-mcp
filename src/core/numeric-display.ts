import { greatestCommonDivisor } from "./integer-math.js";
import { deepFreezeValue } from "./immutability.js";

const significantDigits = 8;
const canonicalUnsignedDecimal = /^(?:0|[1-9][0-9]*)$/u;

export interface NonnegativeRational {
  readonly numerator: string;
  readonly denominator: string;
}

export type RationalDisplay =
  | Readonly<{
      relation: "exact" | "approximately";
      notation: "plain";
      coefficient: string;
      exponent: 0;
    }>
  | Readonly<{
      relation: "exact" | "approximately";
      notation: "scientific";
      coefficient: string;
      exponent: number;
    }>;

const parseRational = (
  value: NonnegativeRational,
  maximumRationalComponentDigits: number,
): Readonly<{ numerator: bigint; denominator: bigint }> => {
  if (
    !canonicalUnsignedDecimal.test(value.numerator) ||
    !canonicalUnsignedDecimal.test(value.denominator) ||
    value.numerator.length > maximumRationalComponentDigits ||
    value.denominator.length > maximumRationalComponentDigits
  ) {
    throw new TypeError("Rational components must be bounded canonical unsigned decimals.");
  }
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  if (denominator === 0n) {
    throw new TypeError("Rational denominator must be positive.");
  }
  if (greatestCommonDivisor(numerator, denominator) !== 1n) {
    throw new TypeError("Rational value must be reduced.");
  }
  if (numerator === 0n && denominator !== 1n) {
    throw new TypeError("Zero rational value must be 0/1.");
  }
  return { numerator, denominator };
};

const compareToPowerOfTen = (
  numerator: bigint,
  denominator: bigint,
  exponent: number,
): number => {
  const left = exponent < 0
    ? numerator * 10n ** BigInt(-exponent)
    : numerator;
  const right = exponent < 0
    ? denominator
    : denominator * 10n ** BigInt(exponent);
  return left === right ? 0 : left < right ? -1 : 1;
};

const rationalExponent = (numerator: bigint, denominator: bigint): number => {
  let exponent = numerator.toString(10).length - denominator.toString(10).length;
  while (compareToPowerOfTen(numerator, denominator, exponent) < 0) exponent -= 1;
  while (compareToPowerOfTen(numerator, denominator, exponent + 1) >= 0) {
    exponent += 1;
  }
  return exponent;
};

const plainCoefficient = (
  significantInteger: string,
  decimalExponent: number,
): string => {
  if (decimalExponent >= 0) {
    return `${significantInteger}${"0".repeat(decimalExponent)}`;
  }
  const fractionalPlaces = -decimalExponent;
  if (significantInteger.length > fractionalPlaces) {
    const point = significantInteger.length - fractionalPlaces;
    return `${significantInteger.slice(0, point)}.${significantInteger.slice(point)}`;
  }
  return `0.${"0".repeat(fractionalPlaces - significantInteger.length)}${significantInteger}`;
};

export const formatCanonicalRationalForDisplay = (
  value: NonnegativeRational,
  maximumRationalComponentDigits: number,
): RationalDisplay => {
  if (!Number.isSafeInteger(maximumRationalComponentDigits) || maximumRationalComponentDigits <= 0) {
    throw new TypeError("Rational component admission bound is invalid.");
  }
  const parsed = parseRational(value, maximumRationalComponentDigits);
  if (parsed.numerator === 0n) {
    return deepFreezeValue({
      relation: "exact",
      notation: "plain",
      coefficient: "0",
      exponent: 0,
    });
  }

  let exponent = rationalExponent(parsed.numerator, parsed.denominator);
  const scaleExponent = significantDigits - 1 - exponent;
  const scaledNumerator = scaleExponent >= 0
    ? parsed.numerator * 10n ** BigInt(scaleExponent)
    : parsed.numerator;
  const scaledDenominator = scaleExponent >= 0
    ? parsed.denominator
    : parsed.denominator * 10n ** BigInt(-scaleExponent);
  let rounded = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  const doubledRemainder = remainder * 2n;
  if (
    doubledRemainder > scaledDenominator ||
    (doubledRemainder === scaledDenominator && rounded % 2n === 1n)
  ) {
    rounded += 1n;
  }
  if (rounded === 10n ** BigInt(significantDigits)) {
    rounded /= 10n;
    exponent += 1;
  }

  const relation = remainder === 0n ? "exact" : "approximately";
  const roundedDigits = rounded.toString(10);
  const trailingZeroCount = roundedDigits.length - roundedDigits.replace(/0+$/u, "").length;
  const significantInteger = roundedDigits.slice(
    0,
    roundedDigits.length - trailingZeroCount,
  );
  const adjustedDecimalExponent =
    exponent - (significantDigits - 1) + trailingZeroCount;

  if (exponent >= -6 && exponent <= 15) {
    return deepFreezeValue({
      relation,
      notation: "plain",
      coefficient: plainCoefficient(significantInteger, adjustedDecimalExponent),
      exponent: 0,
    });
  }

  return deepFreezeValue({
    relation,
    notation: "scientific",
    coefficient: significantInteger.length === 1
      ? significantInteger
      : `${significantInteger.slice(0, 1)}.${significantInteger.slice(1)}`,
    exponent,
  });
};
