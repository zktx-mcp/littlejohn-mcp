import { z } from "zod";

import { greatestCommonDivisor } from "./integer-math.js";
import { deepFreezeValue } from "./immutability.js";
import { jsonObject } from "./json-object.js";
import { unsignedDecimalSchema } from "./primitives.js";

export const exactRationalMaximumDigits = 96 as const;

const maximumComponent = 10n ** BigInt(exactRationalMaximumDigits) - 1n;
const positiveRationalComponentSchema = unsignedDecimalSchema.superRefine((value, context) => {
  if (
    value === "0" ||
    value.length > exactRationalMaximumDigits ||
    BigInt(value) > maximumComponent
  ) {
    context.addIssue({ code: "custom", message: "Integer is outside the supported range." });
  }
});

export const exactRationalSchema = jsonObject({
  numerator: positiveRationalComponentSchema,
  denominator: positiveRationalComponentSchema,
}).strict().superRefine((value, context) => {
  if (greatestCommonDivisor(BigInt(value.numerator), BigInt(value.denominator)) !== 1n) {
    context.addIssue({ code: "custom", message: "Exact rational value is not reduced." });
  }
});
export type ExactRational = z.infer<typeof exactRationalSchema>;

export const createExactRational = (
  numerator: bigint,
  denominator: bigint,
): ExactRational => {
  if (numerator <= 0n || denominator <= 0n) {
    throw new TypeError("Exact rational components must be positive.");
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  return deepFreezeValue(exactRationalSchema.parse({
    numerator: (numerator / divisor).toString(10),
    denominator: (denominator / divisor).toString(10),
  }));
};

export const compareExactRationals = (
  left: ExactRational,
  right: ExactRational,
): number => {
  const leftValue = BigInt(left.numerator) * BigInt(right.denominator);
  const rightValue = BigInt(right.numerator) * BigInt(left.denominator);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
};
