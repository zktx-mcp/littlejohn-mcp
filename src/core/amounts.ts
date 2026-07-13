import { z } from "zod";

import { canonicalJsonStringify, type CanonicalJson } from "./canonical-json.js";
import { isStrictlyOrderedUnique, type ObservationId } from "./evidence.js";
import { robinhoodChainIdentity } from "./identities.js";
import { guardJsonSchema, jsonObject } from "./json-object.js";
import {
  createPrimitiveSchemaSet,
  prefixedCanonicalBase64UrlSchema,
  type ChainAnchor,
} from "./primitives.js";

export const createAmountSchemaSet = () => {
  const primitives = createPrimitiveSchemaSet();
  const observationId = prefixedCanonicalBase64UrlSchema("obs:", 32).brand("ObservationId");
  const nativeAssetIdentity = jsonObject({
    kind: z.literal("native"),
    chainId: z.literal(robinhoodChainIdentity.chainId),
  }).strict();
  const erc20AssetIdentity = jsonObject({
    kind: z.literal("erc20"),
    chainId: z.literal(robinhoodChainIdentity.chainId),
    address: primitives.evmAddress,
  }).strict();
  const assetIdentity = z.discriminatedUnion("kind", [nativeAssetIdentity, erc20AssetIdentity]);
  const tokenDecimals = z.string()
    .regex(/^(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/, "Token decimals must be between 0 and 255.")
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
const semanticAmountSchemas = createAmountSchemaSet();
const semanticCanonicalAmountSchema = guardJsonSchema(semanticAmountSchemas.canonicalAmount);
const semanticAssetIdentitySchema = guardJsonSchema(semanticAmountSchemas.assetIdentity);
const semanticChainAnchorSchema = guardJsonSchema(semanticAmountSchemas.chainAnchor);

export const nativeAssetIdentitySchema = guardJsonSchema(amountSchemas.nativeAssetIdentity);
export const erc20AssetIdentitySchema = guardJsonSchema(amountSchemas.erc20AssetIdentity);
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

export interface ObservationClaimBinding {
  readonly observationId: ObservationId;
  readonly role: string;
  readonly value: CanonicalJson;
  readonly asset?: AssetIdentity;
  readonly chainAnchor?: ChainAnchor;
}

export interface AmountObservationRoles {
  readonly quantity: string;
  readonly decimals: string;
}

const sameAsset = (left: AssetIdentity, right: AssetIdentity): boolean =>
  left.kind === right.kind &&
  left.chainId === right.chainId &&
  (left.kind === "native" || (right.kind === "erc20" && left.address === right.address));

const sameAnchor = (left: ChainAnchor | undefined, right: ChainAnchor | undefined): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.chainId === right.chainId &&
    left.blockNumber === right.blockNumber &&
    left.blockHash === right.blockHash &&
    left.blockTimestamp === right.blockTimestamp
  );
};

export const assertCanonicalAmountBindings = (
  amountInput: unknown,
  bindingsInput: readonly ObservationClaimBinding[],
  permittedNotObservedIds: ReadonlySet<string>,
  roles: AmountObservationRoles,
): CanonicalAmount => {
  const amount = semanticCanonicalAmountSchema.parse(amountInput) as CanonicalAmount;
  const bindings = new Map<string, ObservationClaimBinding>();
  for (const candidate of bindingsInput) {
    const binding = Object.freeze({
      ...candidate,
      ...(candidate.chainAnchor === undefined ? {} : { chainAnchor: semanticChainAnchorSchema.parse(candidate.chainAnchor) }),
      ...(candidate.asset === undefined ? {} : { asset: semanticAssetIdentitySchema.parse(candidate.asset) }),
    });
    const identity = `${binding.observationId}\0${binding.role}`;
    if (bindings.has(identity)) throw new TypeError("Duplicate observation claim binding.");
    bindings.set(identity, binding);
  }

  const quantity = bindings.get(`${amount.quantityObservationId}\0${roles.quantity}`);
  if (
    quantity?.asset === undefined ||
    !sameAsset(quantity.asset, amount.asset) ||
    quantity.value !== amount.raw
  ) {
    throw new TypeError("The quantity observation does not bind the amount role, value, and asset.");
  }

  if (amount.decimals.status === "not_observed") {
    if (!permittedNotObservedIds.has(amount.decimals.scopeExclusionId)) {
      throw new TypeError("The decimals exclusion is not owned by this amount field.");
    }
    return amount;
  }

  const decimalIds = amount.decimals.status === "available"
    ? [amount.decimals.observationId]
    : amount.decimals.observationIds;
  if (roles.decimals === roles.quantity) {
    throw new TypeError("Quantity and decimals require distinct observation claims.");
  }
  const decimalValues: CanonicalJson[] = [];
  for (const observationId of decimalIds) {
    const decimals = bindings.get(`${observationId}\0${roles.decimals}`);
    if (
      decimals?.asset === undefined ||
      !sameAsset(decimals.asset, amount.asset) ||
      !sameAnchor(decimals.chainAnchor, quantity.chainAnchor)
    ) {
      throw new TypeError("The decimals observation does not bind the amount role, asset, and position.");
    }
    decimalValues.push(decimals.value);
  }
  if (amount.decimals.status === "available") {
    if (decimalValues[0] !== amount.decimals.value) {
      throw new TypeError("The decimals observation does not bind the available decimals value.");
    }
  } else if (amount.decimals.reason === "missing") {
    if (decimalValues.some((value) => value !== null)) {
      throw new TypeError("Missing decimals observations must bind a missing value.");
    }
  } else {
    if (
      decimalValues.some((value) =>
        typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 255n) ||
      new Set(decimalValues.map((value) => canonicalJsonStringify(value))).size < 2
    ) {
      throw new TypeError("Conflicting decimals observations must bind distinct canonical values.");
    }
  }
  return amount;
};
