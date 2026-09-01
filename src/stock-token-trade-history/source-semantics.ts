import { z } from "zod";

import {
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

export const stockTokenTradeHistorySourceReasons = Object.freeze([
  "trade_history_unavailable",
  "trade_history_inconsistent",
  "trade_history_too_large",
  "asset_not_supported",
  "outside_published_coverage",
] as const);
export type StockTokenTradeHistorySourceReason =
  (typeof stockTokenTradeHistorySourceReasons)[number];
export const stockTokenTradeHistorySourceScopes = Object.freeze([
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

const gcd = (left: bigint, right: bigint): bigint => {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
};

export const stockTokenTradeHistoryRationalSchema = jsonObject({
  numerator: digits(maximumPriceNumerator.toString().length, true),
  denominator: digits(maximumPriceDenominator.toString().length, true),
}).strict().superRefine((value, context) => {
  if (gcd(BigInt(value.numerator), BigInt(value.denominator)) !== 1n) {
    context.addIssue({ code: "custom", message: "Source rational is not reduced." });
  }
});
export type StockTokenTradeHistoryRational = z.infer<typeof stockTokenTradeHistoryRationalSchema>;

export const stockTokenTradeHistorySwapPositionSchema = jsonObject({
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
export const stockTokenTradeHistoryStoredMemberIdentitySchema = jsonObject(
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
export const stockTokenTradeHistoryPoolFactsSchema = jsonObject({
  historyFrom: stockTokenTradeHistoryCollectionBoundarySchema,
  sourceFrom: stockTokenTradeHistoryCollectionBoundarySchema,
  initialize: stockTokenTradeHistoryInitializeBoundarySchema,
  poolKey: stockTokenTradeHistoryPoolKeySchema,
}).strict();
export type StockTokenTradeHistoryPoolFacts = z.infer<
  typeof stockTokenTradeHistoryPoolFactsSchema
>;

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

export const stockTokenTradeHistorySelectedOwnerMonthSchema = jsonObject({
  ownerMonth: utcMonth,
  monthMember: stockTokenTradeHistoryStoredMemberIdentitySchema,
  resolutionMember: stockTokenTradeHistoryStoredMemberIdentitySchema,
}).strict();
export type StockTokenTradeHistorySelectedOwnerMonth = z.infer<
  typeof stockTokenTradeHistorySelectedOwnerMonthSchema
>;

const sourceGeneralReasonSchema = z.enum([
  "trade_history_unavailable",
  "trade_history_inconsistent",
  "trade_history_too_large",
]);
const sourcePoolsSchema = z.record(stockTokenTradeHistoryPoolIdSchema, stockTokenTradeHistoryPoolFactsSchema)
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
  publishedCoverage: z.array(stockTokenTradeHistoryCoverageSegmentSchema)
    .min(1).max(stockTokenTradeHistorySourceShapeLimits.statePoolPeriods),
  selectedResolutionCoverage: z.array(stockTokenTradeHistoryCoverageSegmentSchema)
    .min(1).max(stockTokenTradeHistorySourceShapeLimits.statePoolPeriods),
  pools: sourcePoolsSchema,
  ownerMonths: z.array(stockTokenTradeHistorySelectedOwnerMonthSchema)
    .min(1).max(stockTokenTradeHistorySourceShapeLimits.stateMonths),
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

export const stockTokenTradeHistorySourceResultSchema = z.union([
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
  const divisor = gcd(quoteScaled, baseScaled);
  return quoteScaled / divisor <= maximumInt128Magnitude &&
    baseScaled / divisor <= maximumInt128Magnitude;
};

export const assertStockTokenTradeHistoryStoredCandle = (input: Readonly<{
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

export const assertStockTokenTradeHistoryPoolFacts = (input: Readonly<{
  poolId: string;
  baseCurrencyAddress: string;
  facts: StockTokenTradeHistoryPoolFacts;
}>): void => {
  const poolId = stockTokenTradeHistoryPoolIdSchema.parse(input.poolId);
  const baseCurrencyAddress = evmAddressSchema.parse(input.baseCurrencyAddress);
  const facts = stockTokenTradeHistoryPoolFactsSchema.parse(input.facts);
  const key = facts.poolKey;
  const baseIsCurrency0 = key.currency0 === baseCurrencyAddress;
  if (
    BigInt(key.currency0) >= BigInt(key.currency1) ||
    !(baseIsCurrency0 && key.currency1 === stockTokenTradeHistorySourceIdentity.usdgAddress ||
      key.currency1 === baseCurrencyAddress &&
      key.currency0 === stockTokenTradeHistorySourceIdentity.usdgAddress) ||
    deriveStockTokenTradeHistoryPoolId(key) !== poolId
  ) throw new TypeError("Pool facts are invalid.");
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

export const assertStockTokenTradeHistoryMemberIdentity = (input: Readonly<{
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
