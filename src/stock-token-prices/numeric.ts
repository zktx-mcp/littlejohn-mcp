import { z } from "zod";
import {greatestCommonDivisor, jsonObject} from "../core/client.js";
import {maximumTokenDecimals} from "../evm/amounts.js";

// A uint160 square over 2^192, scaled by at most 10^255, has at most
// 313 decimal digits per reduced component. The chart's 96-digit type is separate.
export const stockTokenPriceMaximumDigits = 313;
const component = z.string().max(stockTokenPriceMaximumDigits).regex(/^[1-9][0-9]*$/u);
export const stockTokenPriceRatioSchema = jsonObject({
  numerator: component,
  denominator: component,
}).strict().superRefine((value, context) => {
  if (greatestCommonDivisor(BigInt(value.numerator), BigInt(value.denominator)) !== 1n) {
    context.addIssue({ code: "custom", message: "A price must be a reduced positive rational." });
  }
});
export type StockTokenPriceRatio = z.infer<typeof stockTokenPriceRatioSchema>;

export const tokenUnitPoolPrice = (input: Readonly<{
  numerator: bigint;
  denominator: bigint;
  stockDecimals: number;
  quoteDecimals: number;
}>): StockTokenPriceRatio => {
  for (const decimals of [input.stockDecimals, input.quoteDecimals]) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > maximumTokenDecimals) {
      throw new TypeError("Price decimals are outside the token contract.");
    }
  }
  if (input.numerator <= 0n || input.denominator <= 0n) {
    throw new TypeError("A pool price requires positive observed operands.");
  }
  const numerator = input.numerator * 10n ** BigInt(input.stockDecimals);
  const denominator = input.denominator * 10n ** BigInt(input.quoteDecimals);
  const divisor = greatestCommonDivisor(numerator, denominator);
  return Object.freeze(stockTokenPriceRatioSchema.parse({
    numerator: (numerator / divisor).toString(10),
    denominator: (denominator / divisor).toString(10),
  }));
};
