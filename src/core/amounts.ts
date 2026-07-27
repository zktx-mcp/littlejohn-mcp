import { z } from "zod";

import { isStrictlyOrderedUnique } from "./evidence.js";
import { evmChainIdSchema } from "./identities.js";
import { deepFreezeValue } from "./immutability.js";
import { guardJsonSchema, jsonObject } from "./json-object.js";
import {
  createPrimitiveSchemaSet,
  prefixedCanonicalBase64UrlSchema,
} from "./primitives.js";

export const maximumTokenDecimals = 255;
export const scaledUiAmountScale = "1000000000000000000" as const;
const maximumUint256 = (1n << 256n) - 1n;

const amountPrimitives = createPrimitiveSchemaSet();
const isUint256Decimal = (value: string): boolean => {
  try {
    return BigInt(value) <= maximumUint256;
  } catch {
    return false;
  }
};
export const uint256DecimalSchema = guardJsonSchema(
  amountPrimitives.unsignedDecimal.refine(
    isUint256Decimal,
    "Expected a uint256 decimal value.",
  ),
);
export type Uint256Decimal = z.infer<typeof uint256DecimalSchema>;

const availableScaledUiAmountSchema = jsonObject({
  status: z.literal("available"),
  raw: uint256DecimalSchema,
  multiplier: uint256DecimalSchema,
  scale: z.literal(scaledUiAmountScale),
  adjustedRaw: uint256DecimalSchema,
}).strict().superRefine((value, context) => {
  const expected = BigInt(value.raw) * BigInt(value.multiplier) / BigInt(value.scale);
  if (expected > maximumUint256 || value.adjustedRaw !== expected.toString(10)) {
    context.addIssue({ code: "custom", message: "The scaled UI amount is inconsistent." });
  }
});
const unavailableScaledUiAmountSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.literal("result_out_of_range"),
  raw: uint256DecimalSchema,
  multiplier: uint256DecimalSchema,
  scale: z.literal(scaledUiAmountScale),
}).strict().superRefine((value, context) => {
  const expected = BigInt(value.raw) * BigInt(value.multiplier) / BigInt(value.scale);
  if (expected <= maximumUint256) {
    context.addIssue({ code: "custom", message: "The scaled UI amount is representable." });
  }
});

export const scaledUiAmountSchema = guardJsonSchema(z.discriminatedUnion("status", [
  availableScaledUiAmountSchema,
  unavailableScaledUiAmountSchema,
]));
export type ScaledUiAmount = z.infer<typeof scaledUiAmountSchema>;

const parseUint256Decimal = (value: string, name: string): bigint => {
  const parsed = uint256DecimalSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${name} must be a canonical uint256 decimal.`);
  return BigInt(parsed.data);
};

export const calculateScaledUiAmount = (
  raw: string,
  multiplier: string,
): ScaledUiAmount => {
  const rawValue = parseUint256Decimal(raw, "Raw amount");
  const multiplierValue = parseUint256Decimal(multiplier, "UI multiplier");
  const adjusted = rawValue * multiplierValue / BigInt(scaledUiAmountScale);
  if (adjusted > maximumUint256) {
    return deepFreezeValue(scaledUiAmountSchema.parse({
      status: "unavailable",
      reason: "result_out_of_range",
      raw,
      multiplier,
      scale: scaledUiAmountScale,
    }));
  }
  return deepFreezeValue(scaledUiAmountSchema.parse({
    status: "available",
    raw,
    multiplier,
    scale: scaledUiAmountScale,
    adjustedRaw: adjusted.toString(10),
  }));
};

export const formatAmount = (
  rawUnsignedDecimal: string,
  availableDecimals: string,
): string => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(rawUnsignedDecimal)) {
    throw new TypeError("Amount raw units must be a canonical unsigned decimal.");
  }
  if (!new RegExp(canonicalUnsignedDecimalMaximumPattern(maximumTokenDecimals), "u")
    .test(availableDecimals)) {
    throw new TypeError(`Amount decimals must be between 0 and ${maximumTokenDecimals}.`);
  }
  if (availableDecimals === "0") return rawUnsignedDecimal;

  const decimalPlaces = Number(availableDecimals);
  const zeroes = "0".repeat(decimalPlaces);
  const padded = rawUnsignedDecimal.length <= decimalPlaces
    ? `0.${zeroes.slice(rawUnsignedDecimal.length)}${rawUnsignedDecimal}`
    : `${rawUnsignedDecimal.slice(0, -decimalPlaces)}.${rawUnsignedDecimal.slice(-decimalPlaces)}`;
  const withoutTrailingZeroes = padded.replace(/0+$/u, "").replace(/\.$/u, "");

  return withoutTrailingZeroes === "" ? "0" : withoutTrailingZeroes;
};

// Preserve the numeric maximum in emitted JSON Schema instead of enforcing it only at runtime.
export const canonicalUnsignedBigIntMaximumPattern = (maximum: bigint): string => {
  if (maximum < 0n) {
    throw new TypeError("The unsigned-decimal maximum must be non-negative.");
  }
  if (maximum === 0n) return "^(?:0)$";

  const maximumDigits = maximum.toString(10);
  const alternatives: string[] = [];
  for (let length = 1; length < maximumDigits.length; length += 1) {
    const remaining = length - 1;
    alternatives.push(length === 1
      ? "[0-9]"
      : `[1-9]${remaining === 1 ? "[0-9]" : `[0-9]{${remaining}}`}`);
  }

  let prefix = "";
  for (let index = 0; index < maximumDigits.length; index += 1) {
    const maximumDigit = Number(maximumDigits[index]);
    const lower = maximumDigits.length === 1 ? 0 : index === 0 ? 1 : 0;
    const upper = index === maximumDigits.length - 1 ? maximumDigit : maximumDigit - 1;
    if (lower <= upper) {
      const digit = lower === upper
        ? String(lower)
        : upper === lower + 1
          ? `[${lower}${upper}]`
          : `[${lower}-${upper}]`;
      const remaining = maximumDigits.length - index - 1;
      alternatives.push(`${prefix}${digit}${
        remaining === 0 ? "" : remaining === 1 ? "[0-9]" : `[0-9]{${remaining}}`
      }`);
    }
    prefix += maximumDigits[index];
  }
  return `^(?:${alternatives.join("|")})$`;
};

export const canonicalUnsignedDecimalMaximumPattern = (maximum: number): string => {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new TypeError("The unsigned-decimal maximum must be a non-negative safe integer.");
  }
  return canonicalUnsignedBigIntMaximumPattern(BigInt(maximum));
};

export const createAmountSchemaSet = () => {
  const primitives = createPrimitiveSchemaSet();
  const observationId = prefixedCanonicalBase64UrlSchema("obs:", 32).brand("ObservationId");
  const nativeAssetIdentity = jsonObject({
    kind: z.literal("native"),
    chainId: evmChainIdSchema,
  }).strict();
  const erc20AssetIdentity = jsonObject({
    kind: z.literal("erc20"),
    chainId: evmChainIdSchema,
    address: primitives.evmAddress,
  }).strict();
  const assetIdentity = z.discriminatedUnion("kind", [nativeAssetIdentity, erc20AssetIdentity]);
  const tokenDecimals = z.string()
    .regex(
      new RegExp(canonicalUnsignedDecimalMaximumPattern(maximumTokenDecimals), "u"),
      `Token decimals must be between 0 and ${maximumTokenDecimals}.`,
    )
    .brand("UnsignedDecimal");
  const orderedObservationIds = (minimum: number) => z.array(observationId)
    .min(minimum)
    .max(128)
    .superRefine((value, context) => {
      if (!isStrictlyOrderedUnique(value)) {
        context.addIssue({ code: "custom", message: "Decimals observations must be unique and ordered." });
      }
    });
  const availableDecimals = jsonObject({
    status: z.literal("available"),
    value: tokenDecimals,
    observationId,
  }).strict();
  const notObservedDecimals = jsonObject({
    status: z.literal("not_observed"),
    scopeExclusionId: primitives.snakeCaseCode,
  }).strict();
  const missingDecimals = jsonObject({
    status: z.literal("unavailable"),
    reason: z.literal("missing"),
    observationIds: orderedObservationIds(1),
  }).strict();
  const conflictingDecimals = jsonObject({
    status: z.literal("unavailable"),
    reason: z.literal("conflicting"),
    observationIds: orderedObservationIds(2),
  }).strict();
  const decimalsState = z.union([
    availableDecimals,
    notObservedDecimals,
    missingDecimals,
    conflictingDecimals,
  ]);
  const canonicalAmount = jsonObject({
    asset: assetIdentity,
    raw: primitives.unsignedDecimal,
    decimals: decimalsState,
    quantityObservationId: observationId,
  }).strict().superRefine((value, context) => {
    const decimalObservationIds = value.decimals.status === "available"
      ? [value.decimals.observationId]
      : value.decimals.status === "unavailable"
        ? value.decimals.observationIds
        : [];
    if (decimalObservationIds.includes(value.quantityObservationId)) {
      context.addIssue({ code: "custom", message: "Quantity and decimals require distinct observations." });
    }
  });
  const gasUnits = jsonObject({ raw: primitives.unsignedDecimal, observationId }).strict();
  const nativeGasRate = jsonObject({
    numerator: canonicalAmount,
    denominator: jsonObject({ unit: z.literal("gas"), raw: z.literal("1") }).strict(),
    observationId,
  }).strict().superRefine((value, context) => {
    if (value.numerator.asset.kind !== "native") {
      context.addIssue({ code: "custom", message: "A native gas rate requires the native asset." });
    }
    if (value.observationId !== value.numerator.quantityObservationId) {
      context.addIssue({ code: "custom", message: "A gas rate and numerator require the same observation." });
    }
  });
  return Object.freeze({
    nativeAssetIdentity,
    erc20AssetIdentity,
    assetIdentity,
    decimalsState,
    canonicalAmount,
    gasUnits,
    nativeGasRate,
    chainAnchor: primitives.chainAnchor,
  });
};

const amountSchemas = createAmountSchemaSet();

export const nativeAssetIdentitySchema = guardJsonSchema(amountSchemas.nativeAssetIdentity);
export const erc20AssetIdentitySchema = guardJsonSchema(amountSchemas.erc20AssetIdentity);
export type Erc20AssetIdentity = z.infer<typeof erc20AssetIdentitySchema>;
export const assetIdentitySchema = guardJsonSchema(amountSchemas.assetIdentity);
export type AssetIdentity = z.infer<typeof assetIdentitySchema>;

export const decimalsStateSchema = guardJsonSchema(amountSchemas.decimalsState);
export type DecimalsState = z.infer<typeof decimalsStateSchema>;

export const canonicalAmountSchema = guardJsonSchema(amountSchemas.canonicalAmount);
export type CanonicalAmount = z.infer<typeof canonicalAmountSchema>;

export const gasUnitsSchema = guardJsonSchema(amountSchemas.gasUnits);
export type GasUnits = z.infer<typeof gasUnitsSchema>;

export const nativeGasRateSchema = guardJsonSchema(amountSchemas.nativeGasRate);
export type NativeGasRate = z.infer<typeof nativeGasRateSchema>;
