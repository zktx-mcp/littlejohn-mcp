import { z } from "zod";

import {
  greatestCommonDivisor,
  chainAnchorSchema,
  deepFreezeValue,
  evmAddressSchema,
  hash32Schema,
  jsonObject,
  keccak256FromHex,
  maximumTokenDecimals,
  productChainId,
  productUsdgAsset,
  uint256DecimalSchema,
  utcTimestampSchema,
  type UtcTimestamp,
} from "../core/client.js";

export const stockTokenTradeHistorySourceIdentity = deepFreezeValue({
  chainId: productChainId,
  finality: "finalized",
  revision: "db2a56433a39701307353375217998373b50e02d",
  poolManager: evmAddressSchema.parse("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  swapTopic: hash32Schema.parse(
    "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  ),
  usdgAddress: productUsdgAsset.address,
  usdgDecimals: 6,
  resolutions: [
    { label: "1m", intervalSeconds: 60, partition: "day" },
    { label: "15m", intervalSeconds: 900, partition: "month" },
    { label: "30m", intervalSeconds: 1_800, partition: "month" },
    { label: "1h", intervalSeconds: 3_600, partition: "month" },
    { label: "2h", intervalSeconds: 7_200, partition: "month" },
    { label: "4h", intervalSeconds: 14_400, partition: "month" },
    { label: "6h", intervalSeconds: 21_600, partition: "month" },
    { label: "12h", intervalSeconds: 43_200, partition: "month" },
    { label: "1d", intervalSeconds: 86_400, partition: "month" },
    { label: "2d", intervalSeconds: 172_800, partition: "month" },
  ],
} as const);

export const stockTokenTradeHistorySourceShapeLimits = deepFreezeValue({
  rootAssets: 16_384,
  rootBaseCurrencies: 513,
  rootLogicalIds: 255_474,
  statePoolPeriods: 512,
  statePools: 512,
  stateMonths: 13,
  monthCoverageSegments: 512,
  monthDayReferences: 31,
  resolutionCoverageSegments: 512,
  resolutionCandles: 2_976,
} as const);

export type StockTokenTradeHistorySourceResolution =
  (typeof stockTokenTradeHistorySourceIdentity.resolutions)[number];
export type StockTokenTradeHistorySourceResolutionLabel = Exclude<
  StockTokenTradeHistorySourceResolution["label"],
  "1m"
>;
type StoredResolution = Exclude<StockTokenTradeHistorySourceResolution, { readonly label: "1m" }>;
const storedResolutions = stockTokenTradeHistorySourceIdentity.resolutions.slice(1) as
  readonly StoredResolution[];
export const stockTokenTradeHistorySourceResolutionLabels = Object.freeze(
  storedResolutions.map((definition) => definition.label),
) as readonly [
  StockTokenTradeHistorySourceResolutionLabel,
  ...StockTokenTradeHistorySourceResolutionLabel[],
];
export const stockTokenTradeHistorySourceResolution = (
  label: StockTokenTradeHistorySourceResolutionLabel,
): StoredResolution => {
  const definition = storedResolutions.find((candidate) => candidate.label === label);
  if (definition === undefined) throw new TypeError("Trade-history source resolution is invalid.");
  return definition;
};

const stockTokenTradeHistorySourceReasons = Object.freeze([
  "trade_history_unavailable",
  "trade_history_inconsistent",
  "trade_history_too_large",
  "asset_not_supported",
  "outside_published_coverage",
] as const);
export type StockTokenTradeHistorySourceReason =
  (typeof stockTokenTradeHistorySourceReasons)[number];
const stockTokenTradeHistorySourceScopes = Object.freeze([
  "catalog_root",
  "selected_base",
  "selected_period",
] as const);
export type StockTokenTradeHistorySourceScope =
  (typeof stockTokenTradeHistorySourceScopes)[number];

const positiveSafeInteger = z.number().int().positive().safe();
const nonnegativeSafeInteger = z.number().int().nonnegative().safe();
export const stockTokenTradeHistoryBaseDecimalsSchema = z.number()
  .int().nonnegative().max(maximumTokenDecimals);
const wholeSecondTimestamp = utcTimestampSchema.refine(
  (value) => value.endsWith(".000Z"),
  "Expected a whole-second UTC timestamp.",
);
const minuteTimestamp = wholeSecondTimestamp.refine(
  (value) => value.endsWith(":00.000Z"),
  "Expected a minute-aligned UTC timestamp.",
);
const utcMonth = z.string().regex(
  /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])$/u,
  "Expected a UTC calendar month.",
);
const hexSha256 = z.string().regex(
  /^[0-9a-f]{64}$/u,
  "Expected a lowercase SHA-256 digest.",
);

export const stockTokenTradeHistorySourceSemanticSchemas = Object.freeze({
  positiveSafeInteger,
  nonnegativeSafeInteger,
  wholeSecondTimestamp,
  minuteTimestamp,
  utcMonth,
  hexSha256,
});

export const stockTokenTradeHistoryPositionLimit = 185 as const;

export interface StockTokenTradeHistoryNaturalPositionBounds {
  readonly naturalStart: UtcTimestamp;
  readonly naturalEnd: UtcTimestamp;
  readonly representedStart: UtcTimestamp;
  readonly representedEnd: UtcTimestamp;
}

export interface StockTokenTradeHistoryRequestIntervals {
  readonly resolution: Readonly<{
    readonly label: StockTokenTradeHistorySourceResolutionLabel;
    readonly intervalSeconds: number;
    readonly positionCount: number;
  }>;
  readonly naturalWindow: Readonly<{
    readonly fromTimestamp: UtcTimestamp;
    readonly untilTimestamp: UtcTimestamp;
  }>;
  readonly positions: readonly StockTokenTradeHistoryNaturalPositionBounds[];
}

export const stockTokenTradeHistoryNaturalPositionCount = (input: Readonly<{
  readonly requestedStart: UtcTimestamp;
  readonly requestedEnd: UtcTimestamp;
  readonly intervalSeconds: number;
}>): number => {
  const requestedStart = Date.parse(wholeSecondTimestamp.parse(input.requestedStart));
  const requestedEnd = Date.parse(wholeSecondTimestamp.parse(input.requestedEnd));
  const intervalMilliseconds = input.intervalSeconds * 1_000;
  if (
    requestedStart >= requestedEnd ||
    !Number.isSafeInteger(intervalMilliseconds) ||
    intervalMilliseconds <= 0
  ) throw new TypeError("Trade-history natural-position input is invalid.");
  return Math.floor((requestedEnd - 1) / intervalMilliseconds) -
    Math.floor(requestedStart / intervalMilliseconds) + 1;
};

export const selectStockTokenTradeHistoryResolution = (input: Readonly<{
  readonly requestedStart: UtcTimestamp;
  readonly requestedEnd: UtcTimestamp;
}>): StockTokenTradeHistorySourceResolutionLabel => {
  for (const label of stockTokenTradeHistorySourceResolutionLabels) {
    const definition = stockTokenTradeHistorySourceResolution(label);
    if (stockTokenTradeHistoryNaturalPositionCount({
      ...input,
      intervalSeconds: definition.intervalSeconds,
    }) <= stockTokenTradeHistoryPositionLimit) return label;
  }
  throw new TypeError("Trade-history period has no admitted stored resolution.");
};

const positionTimestamp = (milliseconds: number): UtcTimestamp =>
  wholeSecondTimestamp.parse(new Date(milliseconds).toISOString()) as UtcTimestamp;

export const deriveStockTokenTradeHistoryRequestIntervals = (input: Readonly<{
  readonly requestedStart: UtcTimestamp;
  readonly requestedEnd: UtcTimestamp;
}>): StockTokenTradeHistoryRequestIntervals => {
  const requestedStart = wholeSecondTimestamp.parse(input.requestedStart) as UtcTimestamp;
  const requestedEnd = wholeSecondTimestamp.parse(input.requestedEnd) as UtcTimestamp;
  if (requestedStart >= requestedEnd) {
    throw new TypeError("Trade-history request interval is invalid.");
  }
  const label = selectStockTokenTradeHistoryResolution({ requestedStart, requestedEnd });
  const definition = stockTokenTradeHistorySourceResolution(label);
  const intervalMilliseconds = definition.intervalSeconds * 1_000;
  const firstStart = Math.floor(Date.parse(requestedStart) / intervalMilliseconds) *
    intervalMilliseconds;
  const positionCount = stockTokenTradeHistoryNaturalPositionCount({
    requestedStart,
    requestedEnd,
    intervalSeconds: definition.intervalSeconds,
  });
  const positions = Array.from({ length: positionCount }, (_, index) => {
    const naturalStart = positionTimestamp(firstStart + index * intervalMilliseconds);
    const naturalEnd = positionTimestamp(firstStart + (index + 1) * intervalMilliseconds);
    return deepFreezeValue({
      naturalStart,
      naturalEnd,
      representedStart: naturalStart < requestedStart ? requestedStart : naturalStart,
      representedEnd: naturalEnd > requestedEnd ? requestedEnd : naturalEnd,
    });
  });
  const first = positions[0];
  const last = positions.at(-1);
  if (first === undefined || last === undefined) {
    throw new TypeError("Trade-history request has no natural position.");
  }
  return deepFreezeValue({
    resolution: {
      label,
      intervalSeconds: definition.intervalSeconds,
      positionCount,
    },
    naturalWindow: {
      fromTimestamp: first.naturalStart,
      untilTimestamp: last.naturalEnd,
    },
    positions,
  });
};

export const stockTokenTradeHistorySourceInputSchema = jsonObject({
  baseCurrencyAddress: evmAddressSchema,
  baseCurrencyDecimals: stockTokenTradeHistoryBaseDecimalsSchema,
  requestedStart: wholeSecondTimestamp,
  requestedEnd: wholeSecondTimestamp,
  canonicalBlock: chainAnchorSchema,
  resolution: z.enum(stockTokenTradeHistorySourceResolutionLabels),
}).strict().superRefine((value, context) => {
  if (
    value.canonicalBlock.chainId !== productChainId ||
    value.canonicalBlock.blockTimestamp !== value.requestedEnd ||
    Date.parse(value.requestedStart) >= Date.parse(value.requestedEnd)
  ) {
    context.addIssue({ code: "custom", message: "Trade-history source request is inconsistent." });
    return;
  }
  let canonicalResolution: StockTokenTradeHistorySourceResolutionLabel;
  try {
    canonicalResolution = selectStockTokenTradeHistoryResolution({
      requestedStart: value.requestedStart as UtcTimestamp,
      requestedEnd: value.requestedEnd as UtcTimestamp,
    });
  } catch {
    context.addIssue({ code: "custom", message: "Trade-history source period is unsupported." });
    return;
  }
  if (value.resolution !== canonicalResolution) {
    context.addIssue({ code: "custom", message: "Trade-history source resolution is not canonical." });
  }
});
export type StockTokenTradeHistorySourceInput = z.infer<
  typeof stockTokenTradeHistorySourceInputSchema
>;

const maximumInt128Magnitude = 1n << 127n;
const maximumMinuteTradeCount = BigInt(Number.MAX_SAFE_INTEGER);
const maximumResolutionMinutes = BigInt(Math.max(
  ...storedResolutions.map((definition) => definition.intervalSeconds / 60),
));
const maximumDerivedTradeCount = maximumResolutionMinutes * maximumMinuteTradeCount;
const maximumDerivedVolume = maximumDerivedTradeCount * maximumInt128Magnitude;
const maximumPriceNumerator = maximumInt128Magnitude *
  10n ** BigInt(maximumTokenDecimals);
const maximumPriceDenominator = maximumInt128Magnitude *
  10n ** BigInt(stockTokenTradeHistorySourceIdentity.usdgDecimals);

const digits = (maximum: number, positive = false) => z.string()
  .regex(/^(?:0|[1-9][0-9]*)$/u, "Expected a canonical unsigned decimal string.")
  .refine((value) => value.length <= maximum, "Decimal width exceeds product capacity.")
  .refine((value) => !positive || value !== "0", "Expected a positive decimal string.");

const stockTokenTradeHistoryRationalSchema = jsonObject({
  numerator: digits(maximumPriceNumerator.toString().length, true),
  denominator: digits(maximumPriceDenominator.toString().length, true),
}).strict().superRefine((value, context) => {
  if (greatestCommonDivisor(BigInt(value.numerator), BigInt(value.denominator)) !== 1n) {
    context.addIssue({ code: "custom", message: "Source rational is not reduced." });
  }
});
const stockTokenTradeHistorySwapPositionSchema = jsonObject({
  blockHash: hash32Schema,
  blockNumber: uint256DecimalSchema,
  transactionHash: hash32Schema,
  transactionIndex: nonnegativeSafeInteger,
  logIndex: nonnegativeSafeInteger,
}).strict();
export type StockTokenTradeHistorySwapPosition = z.infer<
  typeof stockTokenTradeHistorySwapPositionSchema
>;

export const stockTokenTradeHistoryStoredCandleSchema = jsonObject({
  intervalStart: minuteTimestamp,
  intervalEnd: minuteTimestamp,
  observedStart: minuteTimestamp,
  observedEnd: minuteTimestamp,
  open: stockTokenTradeHistoryRationalSchema,
  high: stockTokenTradeHistoryRationalSchema,
  low: stockTokenTradeHistoryRationalSchema,
  close: stockTokenTradeHistoryRationalSchema,
  baseVolumeRaw: digits(maximumDerivedVolume.toString().length, true),
  quoteVolumeRaw: digits(maximumDerivedVolume.toString().length, true),
  tradeCount: digits(maximumDerivedTradeCount.toString().length, true),
  sourceCandleCount: positiveSafeInteger.max(Number(maximumResolutionMinutes)),
  firstSource: stockTokenTradeHistorySwapPositionSchema,
  lastSource: stockTokenTradeHistorySwapPositionSchema,
}).strict();
export type StockTokenTradeHistoryStoredCandle = z.infer<
  typeof stockTokenTradeHistoryStoredCandleSchema
>;

export const stockTokenTradeHistoryStoredMemberIdentityShape = Object.freeze({
  logicalId: z.string().min(1).max(128),
  assetSha256: hexSha256,
  gzipSha256: hexSha256,
  jsonSha256: hexSha256,
});
const stockTokenTradeHistoryStoredMemberIdentitySchema = jsonObject(
  stockTokenTradeHistoryStoredMemberIdentityShape,
).strict();
export type StockTokenTradeHistoryStoredMemberIdentity = z.infer<
  typeof stockTokenTradeHistoryStoredMemberIdentitySchema
>;

export const stockTokenTradeHistoryCollectionBoundarySchema = jsonObject({
  blockNumber: uint256DecimalSchema,
  timestamp: minuteTimestamp,
}).strict();
export type StockTokenTradeHistoryCollectionBoundary = z.infer<
  typeof stockTokenTradeHistoryCollectionBoundarySchema
>;
export const stockTokenTradeHistoryInitializeBoundarySchema = jsonObject({
  blockNumber: uint256DecimalSchema,
  timestamp: wholeSecondTimestamp,
}).strict();
export type StockTokenTradeHistoryInitializeBoundary = z.infer<
  typeof stockTokenTradeHistoryInitializeBoundarySchema
>;
export const stockTokenTradeHistoryCoverageSegmentSchema = jsonObject({
  fromBlock: uint256DecimalSchema,
  fromTimestamp: minuteTimestamp,
  poolId: hash32Schema,
  untilBlock: uint256DecimalSchema,
  untilTimestamp: minuteTimestamp,
}).strict().superRefine((value, context) => {
  if (
    BigInt(value.fromBlock) > BigInt(value.untilBlock) ||
    value.fromTimestamp >= value.untilTimestamp
  ) context.addIssue({ code: "custom", message: "Source coverage is invalid." });
});
export type StockTokenTradeHistoryCoverageSegment = z.infer<
  typeof stockTokenTradeHistoryCoverageSegmentSchema
>;
export const stockTokenTradeHistoryPoolIdSchema = hash32Schema;
export const stockTokenTradeHistoryPoolKeySchema = jsonObject({
  currency0: evmAddressSchema,
  currency1: evmAddressSchema,
  fee: nonnegativeSafeInteger.max(2 ** 24 - 1),
  tickSpacing: positiveSafeInteger.max(2 ** 23 - 1),
  hooks: evmAddressSchema,
}).strict();
export type StockTokenTradeHistoryPoolKey = z.infer<typeof stockTokenTradeHistoryPoolKeySchema>;

const sourceTimestamp = stockTokenTradeHistorySourceSemanticSchemas.wholeSecondTimestamp;

export const stockTokenTradeHistorySelectedRootSchema = jsonObject({
  publicationSequence: positiveSafeInteger,
  gzipSha256: hexSha256,
  jsonSha256: hexSha256,
  currentUntil: stockTokenTradeHistoryCollectionBoundarySchema,
  poolManager: z.literal(stockTokenTradeHistorySourceIdentity.poolManager),
  usdgAddress: z.literal(stockTokenTradeHistorySourceIdentity.usdgAddress),
  usdgDecimals: z.literal(stockTokenTradeHistorySourceIdentity.usdgDecimals),
}).strict();
export type StockTokenTradeHistorySelectedRoot = z.infer<
  typeof stockTokenTradeHistorySelectedRootSchema
>;

export const stockTokenTradeHistorySelectedBaseSchema = jsonObject({
  baseCurrencyAddress: evmAddressSchema,
  decimals: stockTokenTradeHistoryBaseDecimalsSchema,
  state: stockTokenTradeHistoryStoredMemberIdentitySchema,
}).strict();
export type StockTokenTradeHistorySelectedBase = z.infer<
  typeof stockTokenTradeHistorySelectedBaseSchema
>;

export const stockTokenTradeHistorySelectedMemberSchema = jsonObject({
  ownerMonth: utcMonth,
  member: stockTokenTradeHistoryStoredMemberIdentitySchema,
}).strict();
export type StockTokenTradeHistorySelectedMember = z.infer<
  typeof stockTokenTradeHistorySelectedMemberSchema
>;

const sourceGeneralReasonSchema = z.enum([
  "trade_history_unavailable",
  "trade_history_inconsistent",
  "trade_history_too_large",
]);
const sourcePoolsSchema = z.record(stockTokenTradeHistoryPoolIdSchema, stockTokenTradeHistoryPoolKeySchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > stockTokenTradeHistorySourceShapeLimits.statePools) {
      context.addIssue({ code: "custom", message: "Source Pool facts exceed product capacity." });
    }
  });

const catalogRootUnavailableSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: sourceGeneralReasonSchema,
  scope: z.literal("catalog_root"),
  observedAt: sourceTimestamp,
}).strict();
const selectedBaseUnavailableSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.union([sourceGeneralReasonSchema, z.literal("asset_not_supported")]),
  scope: z.literal("selected_base"),
  observedAt: sourceTimestamp,
  root: stockTokenTradeHistorySelectedRootSchema,
}).strict();
const selectedPeriodUnavailableSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.union([sourceGeneralReasonSchema, z.literal("outside_published_coverage")]),
  scope: z.literal("selected_period"),
  observedAt: sourceTimestamp,
  root: stockTokenTradeHistorySelectedRootSchema,
  base: stockTokenTradeHistorySelectedBaseSchema,
}).strict();
export const stockTokenTradeHistoryAvailableSourceSchema = jsonObject({
  status: z.literal("available"),
  observedAt: sourceTimestamp,
  root: stockTokenTradeHistorySelectedRootSchema,
  base: stockTokenTradeHistorySelectedBaseSchema,
  coverage: z.array(stockTokenTradeHistoryCoverageSegmentSchema)
    .min(1).max(stockTokenTradeHistorySourceShapeLimits.statePoolPeriods),
  pools: sourcePoolsSchema,
  coverageOwnerMonths: z.array(utcMonth)
    .min(1).max(stockTokenTradeHistorySourceShapeLimits.stateMonths),
  monthMembers: z.array(stockTokenTradeHistorySelectedMemberSchema)
    .min(1).max(stockTokenTradeHistorySourceShapeLimits.stateMonths),
  resolutionMembers: z.array(stockTokenTradeHistorySelectedMemberSchema)
    .max(stockTokenTradeHistorySourceShapeLimits.stateMonths),
  candles: z.array(stockTokenTradeHistoryStoredCandleSchema)
    .max(
      stockTokenTradeHistorySourceShapeLimits.stateMonths *
      stockTokenTradeHistorySourceShapeLimits.resolutionCandles,
    ),
}).strict();
export type StockTokenTradeHistoryAvailableSource = z.infer<
  typeof stockTokenTradeHistoryAvailableSourceSchema
>;

export const stockTokenTradeHistoryUnavailableSourceSchema = z.union([
  catalogRootUnavailableSchema,
  selectedBaseUnavailableSchema,
  selectedPeriodUnavailableSchema,
]);
export type StockTokenTradeHistoryUnavailableSource = z.infer<
  typeof stockTokenTradeHistoryUnavailableSourceSchema
>;

const stockTokenTradeHistorySourceResultSchema = z.union([
  stockTokenTradeHistoryAvailableSourceSchema,
  stockTokenTradeHistoryUnavailableSourceSchema,
]);
export type StockTokenTradeHistorySourceResult = z.infer<
  typeof stockTokenTradeHistorySourceResultSchema
>;

const compareRationals = (
  left: Readonly<{ readonly numerator: string; readonly denominator: string }>,
  right: Readonly<{ readonly numerator: string; readonly denominator: string }>,
): number => {
  const difference = BigInt(left.numerator) * BigInt(right.denominator) -
    BigInt(right.numerator) * BigInt(left.denominator);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
};

const compareSwapPositions = (
  left: Pick<StockTokenTradeHistorySwapPosition, "blockNumber" | "transactionIndex" | "logIndex">,
  right: Pick<StockTokenTradeHistorySwapPosition, "blockNumber" | "transactionIndex" | "logIndex">,
): number => {
  const blocks = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (blocks !== 0n) return blocks < 0n ? -1 : 1;
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
};

const abiWord = (value: string | bigint, bytes: number): string => {
  const hex = typeof value === "bigint" ? value.toString(16) : value.slice(2);
  if (hex.length > bytes * 2) throw new TypeError("PoolKey value exceeds its ABI width.");
  return hex.padStart(64, "0");
};

export const deriveStockTokenTradeHistoryPoolId = (
  poolKey: StockTokenTradeHistoryPoolKey,
): string => {
  const admitted = stockTokenTradeHistoryPoolKeySchema.parse(poolKey);
  return keccak256FromHex(`0x${[
    abiWord(admitted.currency0, 20),
    abiWord(admitted.currency1, 20),
    abiWord(BigInt(admitted.fee), 3),
    abiWord(BigInt(admitted.tickSpacing), 3),
    abiWord(admitted.hooks, 20),
  ].join("")}`);
};

const priceHasAdmittedSwapAmounts = (
  price: Readonly<{ readonly numerator: string; readonly denominator: string }>,
  baseDecimals: number,
): boolean => {
  const quoteScaled = BigInt(price.numerator) *
    10n ** BigInt(stockTokenTradeHistorySourceIdentity.usdgDecimals);
  const baseScaled = BigInt(price.denominator) * 10n ** BigInt(baseDecimals);
  const divisor = greatestCommonDivisor(quoteScaled, baseScaled);
  return quoteScaled / divisor <= maximumInt128Magnitude &&
    baseScaled / divisor <= maximumInt128Magnitude;
};

const assertStockTokenTradeHistoryStoredCandle = (input: Readonly<{
  candle: StockTokenTradeHistoryStoredCandle;
  baseDecimals: number;
  resolution: StockTokenTradeHistorySourceResolutionLabel;
  ownerMonth?: string;
}>): void => {
  const candle = stockTokenTradeHistoryStoredCandleSchema.parse(input.candle);
  if (
    !Number.isInteger(input.baseDecimals) ||
    input.baseDecimals < 0 ||
    input.baseDecimals > maximumTokenDecimals
  ) {
    throw new TypeError("Stored candle base decimals are invalid.");
  }
  if (input.ownerMonth !== undefined) utcMonth.parse(input.ownerMonth);
  const definition = stockTokenTradeHistorySourceResolution(input.resolution);
  const start = Date.parse(candle.intervalStart);
  const end = Date.parse(candle.intervalEnd);
  const observedStart = Date.parse(candle.observedStart);
  const observedEnd = Date.parse(candle.observedEnd);
  const spanOrder = compareSwapPositions(candle.firstSource, candle.lastSource);
  const tradeCount = BigInt(candle.tradeCount);
  const tradeCountMaximum = BigInt(candle.sourceCandleCount) * maximumMinuteTradeCount;
  const volumeMaximum = tradeCount * maximumInt128Magnitude;
  const prices = [candle.open, candle.high, candle.low, candle.close];
  if (
    end - start !== definition.intervalSeconds * 1_000 ||
    start % (definition.intervalSeconds * 1_000) !== 0 ||
    (input.ownerMonth !== undefined && candle.intervalStart.slice(0, 7) !== input.ownerMonth) ||
    observedStart < start || observedStart >= observedEnd || observedEnd > end ||
    compareRationals(candle.high, candle.open) < 0 ||
    compareRationals(candle.high, candle.close) < 0 ||
    compareRationals(candle.low, candle.open) > 0 ||
    compareRationals(candle.low, candle.close) > 0 ||
    compareRationals(candle.high, candle.low) < 0 ||
    candle.sourceCandleCount > definition.intervalSeconds / 60 ||
    candle.sourceCandleCount > (observedEnd - observedStart) / 60_000 ||
    tradeCount < BigInt(candle.sourceCandleCount) || tradeCount > tradeCountMaximum ||
    BigInt(candle.baseVolumeRaw) < tradeCount || BigInt(candle.quoteVolumeRaw) < tradeCount ||
    BigInt(candle.baseVolumeRaw) > volumeMaximum || BigInt(candle.quoteVolumeRaw) > volumeMaximum ||
    prices.some((price) => !priceHasAdmittedSwapAmounts(price, input.baseDecimals)) ||
    spanOrder > 0 || (tradeCount === 1n) !== (spanOrder === 0)
  ) throw new TypeError("Stored candle semantics are invalid.");
};

export const assertStockTokenTradeHistoryStoredCandleSequence = (input: Readonly<{
  candles: readonly StockTokenTradeHistoryStoredCandle[];
  baseDecimals: number;
  resolution: StockTokenTradeHistorySourceResolutionLabel;
  ownerMonth?: string;
}>): void => {
  const blockIdentities = new Map<string, string>();
  const transactionIdentities = new Map<string, string>();
  let previous: StockTokenTradeHistoryStoredCandle | undefined;
  const record = (position: StockTokenTradeHistorySwapPosition): void => {
    const knownBlock = blockIdentities.get(position.blockNumber);
    const knownNumber = blockIdentities.get(position.blockHash);
    const coordinate = `${position.blockNumber}:${position.transactionIndex}`;
    const knownTransaction = transactionIdentities.get(coordinate);
    const knownCoordinate = transactionIdentities.get(position.transactionHash);
    if (
      knownBlock !== undefined && knownBlock !== position.blockHash ||
      knownNumber !== undefined && knownNumber !== position.blockNumber ||
      knownTransaction !== undefined && knownTransaction !== position.transactionHash ||
      knownCoordinate !== undefined && knownCoordinate !== coordinate
    ) throw new TypeError("Stored candle source identity conflicts.");
    blockIdentities.set(position.blockNumber, position.blockHash);
    blockIdentities.set(position.blockHash, position.blockNumber);
    transactionIdentities.set(coordinate, position.transactionHash);
    transactionIdentities.set(position.transactionHash, coordinate);
  };
  for (const candle of input.candles) {
    assertStockTokenTradeHistoryStoredCandle({
      candle,
      baseDecimals: input.baseDecimals,
      resolution: input.resolution,
      ...(input.ownerMonth === undefined ? {} : { ownerMonth: input.ownerMonth }),
    });
    record(candle.firstSource);
    record(candle.lastSource);
    if (previous !== undefined && (
      candle.intervalStart <= previous.intervalStart ||
      compareSwapPositions(previous.lastSource, candle.firstSource) >= 0 ||
      BigInt(previous.lastSource.blockNumber) >= BigInt(candle.firstSource.blockNumber)
    )) throw new TypeError("Stored candle sequence is invalid.");
    previous = candle;
  }
};

export const assertStockTokenTradeHistoryPoolIdentity = (input: Readonly<{
  poolId: string;
  baseCurrencyAddress: string;
  poolKey: StockTokenTradeHistoryPoolKey;
}>): void => {
  const poolId = stockTokenTradeHistoryPoolIdSchema.parse(input.poolId);
  const baseCurrencyAddress = evmAddressSchema.parse(input.baseCurrencyAddress);
  const key = stockTokenTradeHistoryPoolKeySchema.parse(input.poolKey);
  const baseIsCurrency0 = key.currency0 === baseCurrencyAddress;
  if (
    BigInt(key.currency0) >= BigInt(key.currency1) ||
    !(baseIsCurrency0 && key.currency1 === stockTokenTradeHistorySourceIdentity.usdgAddress ||
      key.currency1 === baseCurrencyAddress &&
      key.currency0 === stockTokenTradeHistorySourceIdentity.usdgAddress) ||
    deriveStockTokenTradeHistoryPoolId(key) !== poolId
  ) throw new TypeError("Pool identity is invalid.");
};

const logicalId = (input: Readonly<{
  address: string;
  kind: "state" | "month" | "resolution";
  month?: string;
  resolution?: StockTokenTradeHistorySourceResolutionLabel;
}>): string | undefined => {
  const address = evmAddressSchema.parse(input.address);
  if (input.kind === "state") return `base/${address}/state`;
  if (input.month === undefined) return undefined;
  const month = utcMonth.parse(input.month);
  if (input.kind === "month") return `base/${address}/month/${month}`;
  if (input.resolution === undefined) return undefined;
  stockTokenTradeHistorySourceResolution(input.resolution);
  return `base/${address}/resolution/${input.resolution}/${month}`;
};

export const stockTokenTradeHistoryLogicalId = Object.freeze({
  state: (address: string): string => logicalId({ address, kind: "state" })!,
  month: (address: string, month: string): string => logicalId({ address, kind: "month", month })!,
  resolution: (
    address: string,
    resolution: StockTokenTradeHistorySourceResolutionLabel,
    month: string,
  ): string => logicalId({ address, kind: "resolution", resolution, month })!,
});

export const parseStockTokenTradeHistoryMemberLogicalId = (value: string): Readonly<{
  readonly address: string;
  readonly kind: "state" | "month" | "resolution";
  readonly period?: string;
  readonly resolution?: StockTokenTradeHistorySourceResolutionLabel;
}> | undefined => {
  const state = value.match(/^base\/(0x[0-9a-f]{40})\/state$/u);
  if (state !== null) return Object.freeze({ address: state[1]!, kind: "state" });
  const month = value.match(/^base\/(0x[0-9a-f]{40})\/month\/((?:[0-9]{4})-(?:0[1-9]|1[0-2]))$/u);
  if (month !== null) {
    return Object.freeze({ address: month[1]!, kind: "month", period: month[2]! });
  }
  const resolution = value.match(
    /^base\/(0x[0-9a-f]{40})\/resolution\/([^/]+)\/((?:[0-9]{4})-(?:0[1-9]|1[0-2]))$/u,
  );
  if (
    resolution === null ||
    !stockTokenTradeHistorySourceResolutionLabels.includes(
      resolution[2] as StockTokenTradeHistorySourceResolutionLabel,
    )
  ) return undefined;
  return Object.freeze({
    address: resolution[1]!,
    kind: "resolution",
    period: resolution[3]!,
    resolution: resolution[2] as StockTokenTradeHistorySourceResolutionLabel,
  });
};

const assertStockTokenTradeHistoryMemberIdentity = (input: Readonly<{
  member: StockTokenTradeHistoryStoredMemberIdentity;
  address: string;
  kind: "state" | "month" | "resolution";
  month?: string;
  resolution?: StockTokenTradeHistorySourceResolutionLabel;
}>): void => {
  const member = stockTokenTradeHistoryStoredMemberIdentitySchema.parse(input.member);
  if (member.logicalId !== logicalId(input)) {
    throw new TypeError("Stored member identity role is invalid.");
  }
};

export const stockTokenTradeHistoryOwnerMonths = (
  fromValue: string,
  untilValue: string,
): readonly string[] => {
  const from = wholeSecondTimestamp.parse(fromValue);
  const until = wholeSecondTimestamp.parse(untilValue);
  if (from >= until) throw new TypeError("Trade-history owner-month range is invalid.");
  const months: string[] = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00.000Z`);
  const last = new Date(Date.parse(until) - 1).toISOString().slice(0, 7);
  while (true) {
    const month = cursor.toISOString().slice(0, 7);
    months.push(month);
    if (month === last) return Object.freeze(months);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
};

const sameCoverage = (
  left: readonly StockTokenTradeHistoryCoverageSegment[],
  right: readonly StockTokenTradeHistoryCoverageSegment[],
): boolean => left.length === right.length && left.every((segment, index) => {
  const candidate = right[index];
  return candidate !== undefined &&
    segment.fromBlock === candidate.fromBlock &&
    segment.fromTimestamp === candidate.fromTimestamp &&
    segment.poolId === candidate.poolId &&
    segment.untilBlock === candidate.untilBlock &&
    segment.untilTimestamp === candidate.untilTimestamp;
});

export const coalesceStockTokenTradeHistoryCoverage = (
  coverageInput: readonly StockTokenTradeHistoryCoverageSegment[],
): readonly StockTokenTradeHistoryCoverageSegment[] => {
  const coverage = z.array(stockTokenTradeHistoryCoverageSegmentSchema)
    .min(1).max(stockTokenTradeHistorySourceShapeLimits.statePoolPeriods)
    .parse(coverageInput);
  const output: StockTokenTradeHistoryCoverageSegment[] = [];
  for (const segment of coverage) {
    const previous = output.at(-1);
    if (previous !== undefined && (
      previous.untilTimestamp !== segment.fromTimestamp ||
      previous.untilBlock !== segment.fromBlock
    )) throw new TypeError("Trade-history source coverage is not continuous.");
    if (previous !== undefined && previous.poolId === segment.poolId) {
      output[output.length - 1] = deepFreezeValue({
        ...previous,
        untilBlock: segment.untilBlock,
        untilTimestamp: segment.untilTimestamp,
      });
    } else output.push(deepFreezeValue({ ...segment }));
  }
  return deepFreezeValue(output);
};

export interface StockTokenTradeHistoryEligiblePosition
  extends StockTokenTradeHistoryNaturalPositionBounds {
  readonly ownerMonth: string;
  readonly poolId: string;
}

export interface StockTokenTradeHistorySourceRequirements {
  readonly request: StockTokenTradeHistoryRequestIntervals;
  readonly coverage: readonly StockTokenTradeHistoryCoverageSegment[];
  readonly requestedCoverageAvailable: boolean;
  readonly coverageOwnerMonths: readonly string[];
  readonly resolutionOwnerMonths: readonly string[];
  readonly eligiblePositions: readonly StockTokenTradeHistoryEligiblePosition[];
}

export const deriveStockTokenTradeHistorySourceRequirements = (
  inputValue: StockTokenTradeHistorySourceInput,
  coverageInput: readonly StockTokenTradeHistoryCoverageSegment[],
): StockTokenTradeHistorySourceRequirements => {
  const input = stockTokenTradeHistorySourceInputSchema.parse(inputValue);
  const request = deriveStockTokenTradeHistoryRequestIntervals({
    requestedStart: input.requestedStart as UtcTimestamp,
    requestedEnd: input.requestedEnd as UtcTimestamp,
  });
  const allCoverage = coalesceStockTokenTradeHistoryCoverage(coverageInput);
  const canonicalBlock = BigInt(input.canonicalBlock.blockNumber);
  const coverage = allCoverage.filter((segment) =>
    segment.untilTimestamp > request.naturalWindow.fromTimestamp &&
    segment.fromTimestamp < request.naturalWindow.untilTimestamp &&
    BigInt(segment.fromBlock) < canonicalBlock);
  const requestedCoverageAvailable = coverage.some((segment) =>
    segment.untilTimestamp > input.requestedStart &&
    segment.fromTimestamp < input.requestedEnd);
  const coverageOwnerMonths: string[] = [];
  for (const segment of coverage) {
    const fromTimestamp = segment.fromTimestamp < request.naturalWindow.fromTimestamp
      ? request.naturalWindow.fromTimestamp
      : segment.fromTimestamp;
    const untilTimestamp = segment.untilTimestamp > request.naturalWindow.untilTimestamp
      ? request.naturalWindow.untilTimestamp
      : segment.untilTimestamp;
    for (const ownerMonth of stockTokenTradeHistoryOwnerMonths(fromTimestamp, untilTimestamp)) {
      if (coverageOwnerMonths.at(-1) !== ownerMonth) coverageOwnerMonths.push(ownerMonth);
    }
  }
  const eligiblePositions: StockTokenTradeHistoryEligiblePosition[] = [];
  const resolutionOwnerMonths: string[] = [];
  for (const position of request.positions) {
    const matches = coverage.filter((segment) =>
      segment.fromTimestamp <= position.naturalStart &&
      segment.untilTimestamp >= position.naturalEnd);
    if (matches.length !== 1) continue;
    const ownerMonth = position.naturalStart.slice(0, 7);
    eligiblePositions.push(deepFreezeValue({
      ...position,
      ownerMonth,
      poolId: matches[0]!.poolId,
    }));
    if (resolutionOwnerMonths.at(-1) !== ownerMonth) resolutionOwnerMonths.push(ownerMonth);
  }
  return deepFreezeValue({
    request,
    coverage,
    requestedCoverageAvailable,
    coverageOwnerMonths,
    resolutionOwnerMonths,
    eligiblePositions,
  });
};

const stockTokenTradeHistoryPublicCoverageSegmentSchema = jsonObject({
  fromTimestamp: wholeSecondTimestamp,
  poolId: stockTokenTradeHistoryPoolIdSchema,
  untilTimestamp: wholeSecondTimestamp,
}).strict().superRefine((value, context) => {
  if (value.fromTimestamp >= value.untilTimestamp) {
    context.addIssue({ code: "custom", message: "Trade-history public coverage is invalid." });
  }
});
type StockTokenTradeHistoryPublicCoverageSegment = z.infer<
  typeof stockTokenTradeHistoryPublicCoverageSegmentSchema
>;

const stockTokenTradeHistoryPublicCoverageSchema = z.array(
  stockTokenTradeHistoryPublicCoverageSegmentSchema,
).min(1).max(stockTokenTradeHistorySourceShapeLimits.statePoolPeriods)
  .superRefine((value, context) => {
    for (let index = 1; index < value.length; index += 1) {
      if (
        value[index - 1]!.untilTimestamp !== value[index]!.fromTimestamp ||
        value[index - 1]!.poolId === value[index]!.poolId
      ) {
        context.addIssue({
          code: "custom",
          message: "Trade-history public coverage is not canonical.",
        });
        return;
      }
    }
  });

const stockTokenTradeHistoryPositionCoverageStatuses = Object.freeze([
  "complete",
  "partial",
  "unavailable",
] as const);

export const stockTokenTradeHistoryPositionSchema = jsonObject({
  naturalStart: wholeSecondTimestamp,
  naturalEnd: wholeSecondTimestamp,
  representedStart: wholeSecondTimestamp,
  representedEnd: wholeSecondTimestamp,
  coverage: z.enum(stockTokenTradeHistoryPositionCoverageStatuses),
  poolId: stockTokenTradeHistoryPoolIdSchema.nullable(),
  candle: stockTokenTradeHistoryStoredCandleSchema.nullable(),
}).strict().superRefine((value, context) => {
  const complete = value.coverage === "complete" && value.poolId !== null;
  const partial = value.coverage === "partial" && (
    value.candle === null && value.poolId === null ||
    value.candle !== null && value.poolId !== null
  );
  const unavailable = value.coverage === "unavailable" &&
    value.candle === null && value.poolId === null;
  if (
    value.naturalStart >= value.naturalEnd ||
    value.representedStart < value.naturalStart ||
    value.representedEnd > value.naturalEnd ||
    value.representedStart >= value.representedEnd ||
    !(complete || partial || unavailable)
  ) context.addIssue({ code: "custom", message: "Trade-history position is invalid." });
});
export type StockTokenTradeHistoryPosition = z.infer<
  typeof stockTokenTradeHistoryPositionSchema
>;

const stockTokenTradeHistoryCoverageLimitations = Object.freeze([
  "before_published_coverage",
  "after_published_coverage",
] as const);

export const stockTokenTradeHistoryCoverageSummarySchema = jsonObject({
  status: z.enum(["complete", "partial"]),
  limitations: z.array(z.enum(stockTokenTradeHistoryCoverageLimitations)).max(2),
}).strict().superRefine((value, context) => {
  const sequence = value.limitations.join("\0");
  if (
    ![
      "",
      "before_published_coverage",
      "after_published_coverage",
      "before_published_coverage\0after_published_coverage",
    ].includes(sequence) ||
    (value.status === "complete") !== (value.limitations.length === 0)
  ) context.addIssue({ code: "custom", message: "Trade-history coverage summary is invalid." });
});
export type StockTokenTradeHistoryCoverageSummary = z.infer<
  typeof stockTokenTradeHistoryCoverageSummarySchema
>;

export interface StockTokenTradeHistoryPublicDerivation {
  readonly request: StockTokenTradeHistoryRequestIntervals;
  readonly coverage: readonly StockTokenTradeHistoryPublicCoverageSegment[];
  readonly requestedCoverage: readonly StockTokenTradeHistoryPublicCoverageSegment[];
  readonly coverageOwnerMonths: readonly string[];
  readonly resolutionOwnerMonths: readonly string[];
  readonly coverageSummary: StockTokenTradeHistoryCoverageSummary;
  readonly positions: readonly StockTokenTradeHistoryPosition[];
}

const projectCoverage = (input: Readonly<{
  coverage: readonly Readonly<{
    readonly fromTimestamp: string;
    readonly poolId: string;
    readonly untilTimestamp: string;
  }>[];
  fromTimestamp: UtcTimestamp;
  untilTimestamp: UtcTimestamp;
}>): readonly StockTokenTradeHistoryPublicCoverageSegment[] =>
  deepFreezeValue(stockTokenTradeHistoryPublicCoverageSchema.parse(
    input.coverage.flatMap((segment) => {
      if (
        segment.untilTimestamp <= input.fromTimestamp ||
        segment.fromTimestamp >= input.untilTimestamp
      ) return [];
      return [{
        fromTimestamp: segment.fromTimestamp < input.fromTimestamp
          ? input.fromTimestamp
          : segment.fromTimestamp,
        poolId: segment.poolId,
        untilTimestamp: segment.untilTimestamp > input.untilTimestamp
          ? input.untilTimestamp
          : segment.untilTimestamp,
      }];
    }),
  ));

const projectStockTokenTradeHistoryRequestedCoverage = (input: Readonly<{
  readonly requestedStart: UtcTimestamp;
  readonly requestedEnd: UtcTimestamp;
  readonly coverage: readonly StockTokenTradeHistoryPublicCoverageSegment[];
}>): readonly StockTokenTradeHistoryPublicCoverageSegment[] => projectCoverage({
  coverage: input.coverage,
  fromTimestamp: input.requestedStart,
  untilTimestamp: input.requestedEnd,
});

const publicCoverageOwnerMonths = (input: Readonly<{
  coverage: readonly StockTokenTradeHistoryPublicCoverageSegment[];
}>): readonly string[] => {
  const months: string[] = [];
  for (const segment of input.coverage) {
    for (const ownerMonth of stockTokenTradeHistoryOwnerMonths(
      segment.fromTimestamp,
      segment.untilTimestamp,
    )) {
      if (months.at(-1) !== ownerMonth) months.push(ownerMonth);
    }
  }
  return deepFreezeValue(months);
};

export const deriveStockTokenTradeHistoryPublicData = (inputValue: Readonly<{
  readonly sourceInput: StockTokenTradeHistorySourceInput;
  readonly coverage: readonly Readonly<{
    readonly fromTimestamp: string;
    readonly poolId: string;
    readonly untilTimestamp: string;
  }>[];
  readonly resolutionOwnerMonths: readonly string[];
  readonly candles: readonly StockTokenTradeHistoryStoredCandle[];
}>): StockTokenTradeHistoryPublicDerivation => {
  const sourceInput = stockTokenTradeHistorySourceInputSchema.parse(inputValue.sourceInput);
  const request = deriveStockTokenTradeHistoryRequestIntervals({
    requestedStart: sourceInput.requestedStart as UtcTimestamp,
    requestedEnd: sourceInput.requestedEnd as UtcTimestamp,
  });
  const coverage = projectCoverage({
    coverage: inputValue.coverage,
    fromTimestamp: request.naturalWindow.fromTimestamp,
    untilTimestamp: request.naturalWindow.untilTimestamp,
  });
  const requestedCoverage = projectStockTokenTradeHistoryRequestedCoverage({
    requestedStart: sourceInput.requestedStart as UtcTimestamp,
    requestedEnd: sourceInput.requestedEnd as UtcTimestamp,
    coverage,
  });
  const expectedResolutionOwnerMonths: string[] = [];
  const containingByStart = new Map<string, StockTokenTradeHistoryPublicCoverageSegment>();
  for (const position of request.positions) {
    const containing = coverage.filter((segment) =>
      segment.fromTimestamp <= position.naturalStart &&
      segment.untilTimestamp >= position.naturalEnd);
    if (containing.length !== 1) continue;
    containingByStart.set(position.naturalStart, containing[0]!);
    const ownerMonth = position.naturalStart.slice(0, 7);
    if (expectedResolutionOwnerMonths.at(-1) !== ownerMonth) {
      expectedResolutionOwnerMonths.push(ownerMonth);
    }
  }
  if (
    inputValue.resolutionOwnerMonths.length !== expectedResolutionOwnerMonths.length ||
    inputValue.resolutionOwnerMonths.some((ownerMonth, index) =>
      ownerMonth !== expectedResolutionOwnerMonths[index])
  ) throw new TypeError("Trade-history public resolution owners are inconsistent.");

  assertStockTokenTradeHistoryStoredCandleSequence({
    candles: inputValue.candles,
    baseDecimals: sourceInput.baseCurrencyDecimals,
    resolution: sourceInput.resolution,
  });
  const candles = new Map<string, StockTokenTradeHistoryStoredCandle>();
  for (const candle of inputValue.candles) {
    if (candles.has(candle.intervalStart)) {
      throw new TypeError("Trade-history source contains duplicate position candles.");
    }
    candles.set(candle.intervalStart, candle);
  }
  const positions = request.positions.map((position) => {
    const overlaps = coverage.some((segment) =>
      segment.untilTimestamp > position.representedStart &&
      segment.fromTimestamp < position.representedEnd);
    const containing = containingByStart.get(position.naturalStart);
    const requestCut = position.representedStart !== position.naturalStart ||
      position.representedEnd !== position.naturalEnd;
    const candle = candles.get(position.naturalStart) ?? null;
    if (candle !== null) {
      if (
        containing === undefined ||
        candle.intervalEnd !== position.naturalEnd ||
        BigInt(candle.lastSource.blockNumber) >= BigInt(sourceInput.canonicalBlock.blockNumber)
      ) throw new TypeError("Trade-history candle has no eligible natural position.");
      candles.delete(position.naturalStart);
      return stockTokenTradeHistoryPositionSchema.parse({
        ...position,
        coverage: requestCut ? "partial" : "complete",
        poolId: containing.poolId,
        candle,
      });
    }
    if (!overlaps) {
      return stockTokenTradeHistoryPositionSchema.parse({
        ...position,
        coverage: "unavailable",
        poolId: null,
        candle: null,
      });
    }
    if (!requestCut && containing !== undefined) {
      return stockTokenTradeHistoryPositionSchema.parse({
        ...position,
        coverage: "complete",
        poolId: containing.poolId,
        candle: null,
      });
    }
    return stockTokenTradeHistoryPositionSchema.parse({
      ...position,
      coverage: "partial",
      poolId: null,
      candle: null,
    });
  });
  if (candles.size !== 0) {
    throw new TypeError("Trade-history source candle has no request position.");
  }
  const limitations = [
    ...(requestedCoverage[0]?.fromTimestamp !== sourceInput.requestedStart
      ? ["before_published_coverage" as const]
      : []),
    ...(requestedCoverage.at(-1)?.untilTimestamp !== sourceInput.requestedEnd
      ? ["after_published_coverage" as const]
      : []),
  ];
  return deepFreezeValue({
    request,
    coverage,
    requestedCoverage,
    coverageOwnerMonths: publicCoverageOwnerMonths({ coverage }),
    resolutionOwnerMonths: expectedResolutionOwnerMonths,
    coverageSummary: stockTokenTradeHistoryCoverageSummarySchema.parse({
      status: limitations.length === 0 ? "complete" : "partial",
      limitations,
    }),
    positions,
  });
};

export const assertStockTokenTradeHistorySelectedBaseIdentity = (input: Readonly<{
  base: StockTokenTradeHistorySelectedBase;
  baseCurrencyAddress: string;
  baseCurrencyDecimals: number;
}>): void => {
  const base = stockTokenTradeHistorySelectedBaseSchema.parse(input.base);
  const baseCurrencyAddress = evmAddressSchema.parse(input.baseCurrencyAddress);
  const baseCurrencyDecimals = stockTokenTradeHistoryBaseDecimalsSchema.parse(
    input.baseCurrencyDecimals,
  );
  if (
    base.baseCurrencyAddress !== baseCurrencyAddress ||
    base.decimals !== baseCurrencyDecimals
  ) throw new TypeError("Trade-history selected base identity is inconsistent.");
  assertStockTokenTradeHistoryMemberIdentity({
    member: base.state,
    address: baseCurrencyAddress,
    kind: "state",
  });
};

export const assertStockTokenTradeHistoryCoveragePoolKeys = (input: Readonly<{
  coverage: readonly Readonly<{ readonly poolId: string }>[];
  pools: Readonly<Record<string, StockTokenTradeHistoryPoolKey>>;
  baseCurrencyAddress: string;
}>): void => {
  const requiredPoolIds = [...new Set(input.coverage.map((segment) =>
    stockTokenTradeHistoryPoolIdSchema.parse(segment.poolId)))].sort();
  const actualPoolIds = Object.keys(input.pools).sort();
  if (
    requiredPoolIds.length !== actualPoolIds.length ||
    requiredPoolIds.some((poolId, index) => poolId !== actualPoolIds[index])
  ) throw new TypeError("Trade-history Pool identities are incomplete.");
  for (const poolId of requiredPoolIds) {
    assertStockTokenTradeHistoryPoolIdentity({
      poolId,
      baseCurrencyAddress: input.baseCurrencyAddress,
      poolKey: input.pools[poolId]!,
    });
  }
};

export const assertStockTokenTradeHistoryMemberIdentities = (input: Readonly<{
  members: readonly StockTokenTradeHistorySelectedMember[];
  expectedOwnerMonths: readonly string[];
  baseCurrencyAddress: string;
  kind: "month" | "resolution";
  resolution: StockTokenTradeHistorySourceResolutionLabel;
}>): void => {
  if (
    input.expectedOwnerMonths.length !== input.members.length ||
    input.members.some((owner, index) => owner.ownerMonth !== input.expectedOwnerMonths[index])
  ) throw new TypeError("Trade-history owner-month identities are incomplete.");
  for (const ownerInput of input.members) {
    const owner = stockTokenTradeHistorySelectedMemberSchema.parse(ownerInput);
    assertStockTokenTradeHistoryMemberIdentity({
      member: owner.member,
      address: input.baseCurrencyAddress,
      kind: input.kind,
      month: owner.ownerMonth,
      ...(input.kind === "resolution" ? { resolution: input.resolution } : {}),
    });
  }
};

export const admitStockTokenTradeHistorySourceResult = (
  inputValue: StockTokenTradeHistorySourceInput,
  resultValue: StockTokenTradeHistorySourceResult,
): StockTokenTradeHistorySourceResult => {
  const input = stockTokenTradeHistorySourceInputSchema.parse(inputValue);
  const result = stockTokenTradeHistorySourceResultSchema.parse(resultValue);
  if (result.status === "unavailable") {
    if (result.scope === "selected_period") {
      assertStockTokenTradeHistorySelectedBaseIdentity({
        base: result.base,
        baseCurrencyAddress: input.baseCurrencyAddress,
        baseCurrencyDecimals: input.baseCurrencyDecimals,
      });
    }
    return deepFreezeValue(result);
  }

  assertStockTokenTradeHistorySelectedBaseIdentity({
    base: result.base,
    baseCurrencyAddress: input.baseCurrencyAddress,
    baseCurrencyDecimals: input.baseCurrencyDecimals,
  });
  const requirements = deriveStockTokenTradeHistorySourceRequirements(input, result.coverage);
  const firstCoverage = result.coverage[0];
  const lastCoverage = result.coverage.at(-1);
  if (
    firstCoverage === undefined ||
    lastCoverage === undefined ||
    !sameCoverage(result.coverage, requirements.coverage) ||
    lastCoverage.untilTimestamp > result.root.currentUntil.timestamp ||
    BigInt(lastCoverage.untilBlock) > BigInt(result.root.currentUntil.blockNumber)
  ) throw new TypeError("Trade-history coverage is not the admitted natural-window sequence.");

  assertStockTokenTradeHistoryCoveragePoolKeys({
    coverage: result.coverage,
    pools: result.pools,
    baseCurrencyAddress: input.baseCurrencyAddress,
  });

  if (requirements.coverage.length === 0 || !requirements.requestedCoverageAvailable) {
    throw new TypeError("Trade-history source coverage does not intersect its request.");
  }
  if (
    result.coverageOwnerMonths.length !== requirements.coverageOwnerMonths.length ||
    result.coverageOwnerMonths.some((ownerMonth, index) =>
      ownerMonth !== requirements.coverageOwnerMonths[index])
  ) throw new TypeError("Trade-history coverage-owner months are inconsistent.");
  assertStockTokenTradeHistoryMemberIdentities({
    members: result.monthMembers,
    expectedOwnerMonths: requirements.coverageOwnerMonths,
    baseCurrencyAddress: input.baseCurrencyAddress,
    kind: "month",
    resolution: input.resolution,
  });
  assertStockTokenTradeHistoryMemberIdentities({
    members: result.resolutionMembers,
    expectedOwnerMonths: requirements.resolutionOwnerMonths,
    baseCurrencyAddress: input.baseCurrencyAddress,
    kind: "resolution",
    resolution: input.resolution,
  });

  assertStockTokenTradeHistoryStoredCandleSequence({
    candles: result.candles,
    baseDecimals: input.baseCurrencyDecimals,
    resolution: input.resolution,
  });
  const eligibleByStart = new Map(requirements.eligiblePositions.map((position) =>
    [position.naturalStart, position] as const));
  const admittedResolutionOwners = new Set(
    result.resolutionMembers.map((entry) => entry.ownerMonth),
  );
  for (const candle of result.candles) {
    const position = eligibleByStart.get(candle.intervalStart);
    const matches = result.coverage.filter((segment) =>
      segment.poolId === position?.poolId &&
      segment.fromTimestamp <= candle.intervalStart &&
      segment.untilTimestamp >= candle.intervalEnd &&
      BigInt(segment.fromBlock) <= BigInt(candle.firstSource.blockNumber) &&
      BigInt(segment.untilBlock) > BigInt(candle.lastSource.blockNumber));
    if (
      position === undefined ||
      candle.intervalEnd !== position.naturalEnd ||
      !admittedResolutionOwners.has(position.ownerMonth) ||
      BigInt(candle.lastSource.blockNumber) >= BigInt(input.canonicalBlock.blockNumber) ||
      matches.length !== 1
    ) throw new TypeError("Trade-history source candle is outside admitted coverage.");
  }
  return deepFreezeValue(result);
};
