import { greatestCommonDivisor } from "./integer-math.js";
import {
  canonicalUnsignedDecimalMaximumPattern,
  maximumTokenDecimals,
} from "./amounts.js";
import { deepFreezeValue } from "./immutability.js";
import {
  exactRationalSchema,
  exactRationalMaximumDigits,
  type ExactRational,
} from "./exact-rational.js";

const significantDigits = 8;
const maximumRationalComponentDigits =
  exactRationalMaximumDigits + maximumTokenDecimals;
const canonicalUnsignedDecimal = /^(?:0|[1-9][0-9]*)$/u;
const tokenDecimalsPattern = new RegExp(
  canonicalUnsignedDecimalMaximumPattern(maximumTokenDecimals),
  "u",
);

export interface NonnegativeRational {
  readonly numerator: string;
  readonly denominator: string;
}

export interface ExactTokenUnitPrice {
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

export const formatRationalForDisplay = (
  value: NonnegativeRational,
): RationalDisplay => {
  const parsed = parseRational(value);
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

export const scaleRawUnitPriceToTokenUnits = (
  rawUnitPrice: ExactRational,
  inputDecimals: string,
  outputDecimals: string,
): ExactTokenUnitPrice => {
  const price = exactRationalSchema.parse(rawUnitPrice);
  if (!tokenDecimalsPattern.test(inputDecimals) || !tokenDecimalsPattern.test(outputDecimals)) {
    throw new TypeError(`Token decimals must be between 0 and ${maximumTokenDecimals}.`);
  }
  const numerator = BigInt(price.numerator) * 10n ** BigInt(inputDecimals);
  const denominator = BigInt(price.denominator) * 10n ** BigInt(outputDecimals);
  const divisor = greatestCommonDivisor(numerator, denominator);
  return deepFreezeValue({
    numerator: (numerator / divisor).toString(10),
    denominator: (denominator / divisor).toString(10),
  });
};
