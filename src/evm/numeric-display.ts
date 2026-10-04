import {greatestCommonDivisor, deepFreezeValue, exactRationalSchema, exactRationalMaximumDigits, type ExactRational, type NonnegativeRational, type RationalDisplay, formatCanonicalRationalForDisplay} from "../core/client.js";
import {canonicalUnsignedDecimalMaximumPattern, maximumTokenDecimals} from "./amounts.js";
const tokenDecimalsPattern = new RegExp(canonicalUnsignedDecimalMaximumPattern(maximumTokenDecimals), "u");
export interface ExactTokenUnitPrice { readonly numerator: string; readonly denominator: string }
export const formatRationalForDisplay = (value: NonnegativeRational): RationalDisplay => formatCanonicalRationalForDisplay(value, exactRationalMaximumDigits + maximumTokenDecimals);

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
