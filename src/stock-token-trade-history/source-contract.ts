import { z } from "zod";

import {
  chainAnchorSchema,
  deepFreezeValue,
  evmAddressSchema,
  jsonObject,
  productChainId,
  utcTimestampSchema,
  type EvmAddress,
  type UtcTimestamp,
} from "../core/index.js";

export const stockTokenTradeHistorySourceContract = deepFreezeValue({
  owner: "stelis-dev/robinhood-stock-token-index",
  revision: "db2a56433a39701307353375217998373b50e02d",
  reference:
    "https://github.com/stelis-dev/robinhood-stock-token-index/blob/db2a56433a39701307353375217998373b50e02d/README.md",
  poolManager: evmAddressSchema.parse("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  usdgAddress: evmAddressSchema.parse("0x5fc5360d0400a0fd4f2af552add042d716f1d168"),
  usdgDecimals: 6,
  maximumReleaseAssets: 1_000,
  maximumPhysicalAssetBytes: 430_563_600,
  maximumRedirects: 5,
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

export type StockTokenTradeHistorySourceResolution =
  (typeof stockTokenTradeHistorySourceContract.resolutions)[number];
export type StockTokenTradeHistorySourceResolutionLabel =
  Exclude<StockTokenTradeHistorySourceResolution["label"], "1m">;

type DerivedSourceResolution = Exclude<
  StockTokenTradeHistorySourceResolution,
  { readonly label: "1m" }
>;

const derivedResolutionDefinitions =
  stockTokenTradeHistorySourceContract.resolutions.slice(1) as readonly DerivedSourceResolution[];

export const stockTokenTradeHistorySourceResolutionLabels = Object.freeze(
  derivedResolutionDefinitions.map((definition) => definition.label),
) as readonly [
  StockTokenTradeHistorySourceResolutionLabel,
  ...StockTokenTradeHistorySourceResolutionLabel[],
];

export const stockTokenTradeHistorySourceResolution = (
  label: StockTokenTradeHistorySourceResolutionLabel,
): DerivedSourceResolution => {
  const definition = derivedResolutionDefinitions.find((candidate) => candidate.label === label);
  if (definition === undefined) throw new TypeError("Trade-history source resolution is invalid.");
  return definition;
};

const positiveSafeInteger = z.number().int().positive().safe();
const nonnegativeSafeInteger = z.number().int().nonnegative().safe();
const wholeSecondTimestampSchema = utcTimestampSchema.refine(
  (value) => value.endsWith(".000Z"),
  "Expected a whole-second UTC timestamp.",
);
const minuteTimestampSchema = wholeSecondTimestampSchema.refine(
  (value) => value.endsWith(":00.000Z"),
  "Expected a minute-aligned UTC timestamp.",
);
const utcMonthSchema = z.string().regex(
  /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])$/u,
  "Expected a UTC calendar month.",
);
const hexSha256Schema = z.string().regex(
  /^[0-9a-f]{64}$/u,
  "Expected a lowercase SHA-256 digest.",
);

export const stockTokenTradeHistorySourceLimitSchema = jsonObject({
  catalogResponseBytes: positiveSafeInteger,
  rootCompressedBytes: positiveSafeInteger,
  rootDecodedBytes: positiveSafeInteger,
  memberCompressedBytes: positiveSafeInteger,
  memberDecodedBytes: positiveSafeInteger,
  cumulativeTransportBytes: positiveSafeInteger,
  cumulativeDecodedBytes: positiveSafeInteger,
  rootAssets: positiveSafeInteger,
  rootBaseCurrencies: positiveSafeInteger,
  rootLogicalIds: positiveSafeInteger,
  statePoolPeriods: positiveSafeInteger,
  statePools: positiveSafeInteger,
  stateMonths: positiveSafeInteger,
  monthCoverageSegments: positiveSafeInteger,
  monthDayReferences: positiveSafeInteger,
  resolutionCoverageSegments: positiveSafeInteger,
  resolutionCandles: positiveSafeInteger,
  concurrentMemberReads: positiveSafeInteger,
  deadlineMilliseconds: positiveSafeInteger,
}).strict();

export type StockTokenTradeHistorySourceLimits = z.infer<
  typeof stockTokenTradeHistorySourceLimitSchema
>;

export const stockTokenTradeHistorySourceLimits = deepFreezeValue(
  stockTokenTradeHistorySourceLimitSchema.parse({
    catalogResponseBytes: 2_097_152,
    rootCompressedBytes: 23_068_672,
    rootDecodedBytes: 23_068_672,
    memberCompressedBytes: 8_388_608,
    memberDecodedBytes: 8_388_608,
    cumulativeTransportBytes: 67_108_864,
    cumulativeDecodedBytes: 33_554_432,
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
    concurrentMemberReads: 2,
    deadlineMilliseconds: 60_000,
  }),
) as StockTokenTradeHistorySourceLimits;

export const stockTokenTradeHistorySourceInputSchema = jsonObject({
  baseCurrencyAddress: evmAddressSchema,
  baseCurrencyDecimals: z.number().int().nonnegative().max(255),
  requestedStart: wholeSecondTimestampSchema,
  requestedEnd: wholeSecondTimestampSchema,
  canonicalBlock: chainAnchorSchema,
  resolution: z.enum(stockTokenTradeHistorySourceResolutionLabels),
}).strict().superRefine((value, context) => {
  if (
    value.canonicalBlock.chainId !== productChainId ||
    value.canonicalBlock.blockTimestamp !== value.requestedEnd ||
    Date.parse(value.requestedStart) >= Date.parse(value.requestedEnd)
  ) context.addIssue({ code: "custom", message: "Trade-history source request is inconsistent." });
});

export type StockTokenTradeHistorySourceInput = z.infer<
  typeof stockTokenTradeHistorySourceInputSchema
>;

export type StockTokenTradeHistoryProviderOutcome<Value> =
  | Readonly<{ readonly status: "read"; readonly value: Value }>
  | Readonly<{ readonly status: "absent" }>
  | Readonly<{ readonly status: "unavailable" }>
  | Readonly<{ readonly status: "rate_limited" }>
  | Readonly<{ readonly status: "capacity_exceeded" }>;

export interface StockTokenTradeHistoryCatalogAssetFact {
  readonly name: string;
  readonly bytes: number;
}

export interface StockTokenTradeHistoryCatalogFacts {
  readonly assets: readonly StockTokenTradeHistoryCatalogAssetFact[];
  readonly overflow: boolean;
  readonly transferredBytes: number;
}

export interface StockTokenTradeHistoryCompleteObjectFacts {
  readonly bytes: Uint8Array;
  readonly identityEncoding: boolean;
}

export interface StockTokenTradeHistoryRangeFacts
  extends StockTokenTradeHistoryCompleteObjectFacts {
  readonly range: Readonly<{
    readonly from: number;
    readonly until: number;
    readonly assetBytes: number;
  }> | null;
}

export interface StockTokenTradeHistoryProviderTransport {
  readCatalog(
    maximumResponseBytes: number,
    maximumTotalBytes: number,
    maximumAssets: number,
    signal: AbortSignal,
  ): Promise<StockTokenTradeHistoryProviderOutcome<StockTokenTradeHistoryCatalogFacts>>;
  readRoot(
    name: string,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<StockTokenTradeHistoryProviderOutcome<StockTokenTradeHistoryCompleteObjectFacts>>;
  readMember(
    input: Readonly<{
      readonly releaseTag: string;
      readonly assetName: string;
      readonly from: number;
      readonly until: number;
      readonly maximumBytes: number;
    }>,
    signal: AbortSignal,
  ): Promise<StockTokenTradeHistoryProviderOutcome<StockTokenTradeHistoryRangeFacts>>;
}

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

export interface StockTokenTradeHistoryCollectionBoundary {
  readonly blockNumber: string;
  readonly timestamp: UtcTimestamp;
}

export interface StockTokenTradeHistoryCoverageSegment {
  readonly fromBlock: string;
  readonly fromTimestamp: UtcTimestamp;
  readonly poolId: string;
  readonly untilBlock: string;
  readonly untilTimestamp: UtcTimestamp;
}

export interface StockTokenTradeHistoryPoolKey {
  readonly currency0: EvmAddress;
  readonly currency1: EvmAddress;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: EvmAddress;
}

export interface StockTokenTradeHistoryPoolFacts {
  readonly historyFrom: StockTokenTradeHistoryCollectionBoundary;
  readonly sourceFrom: StockTokenTradeHistoryCollectionBoundary;
  readonly initialize: StockTokenTradeHistoryCollectionBoundary;
  readonly poolKey: StockTokenTradeHistoryPoolKey;
}

export interface StockTokenTradeHistoryStoredMemberIdentity {
  readonly logicalId: string;
  readonly assetSha256: string;
  readonly gzipSha256: string;
  readonly jsonSha256: string;
}

export interface StockTokenTradeHistorySelectedRoot {
  readonly publicationSequence: number;
  readonly gzipSha256: string;
  readonly jsonSha256: string;
  readonly currentUntil: StockTokenTradeHistoryCollectionBoundary;
  readonly poolManager: EvmAddress;
  readonly usdgAddress: EvmAddress;
  readonly usdgDecimals: number;
}

export interface StockTokenTradeHistorySelectedBase {
  readonly baseCurrencyAddress: EvmAddress;
  readonly decimals: number;
  readonly state: StockTokenTradeHistoryStoredMemberIdentity;
  readonly poolPeriods: readonly StockTokenTradeHistoryCoverageSegment[];
  readonly pools: Readonly<Record<string, StockTokenTradeHistoryPoolFacts>>;
}

export interface StockTokenTradeHistorySwapPosition {
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly transactionIndex: number;
  readonly logIndex: number;
}

export interface StockTokenTradeHistoryRational {
  readonly numerator: string;
  readonly denominator: string;
}

export interface StockTokenTradeHistoryStoredCandle {
  readonly intervalStart: UtcTimestamp;
  readonly intervalEnd: UtcTimestamp;
  readonly observedStart: UtcTimestamp;
  readonly observedEnd: UtcTimestamp;
  readonly open: StockTokenTradeHistoryRational;
  readonly high: StockTokenTradeHistoryRational;
  readonly low: StockTokenTradeHistoryRational;
  readonly close: StockTokenTradeHistoryRational;
  readonly baseVolumeRaw: string;
  readonly quoteVolumeRaw: string;
  readonly tradeCount: string;
  readonly sourceCandleCount: number;
  readonly firstSource: StockTokenTradeHistorySwapPosition;
  readonly lastSource: StockTokenTradeHistorySwapPosition;
}

export interface StockTokenTradeHistorySelectedOwnerMonth {
  readonly ownerMonth: string;
  readonly month: Readonly<{
    readonly member: StockTokenTradeHistoryStoredMemberIdentity;
    readonly coverage: readonly StockTokenTradeHistoryCoverageSegment[];
  }>;
  readonly resolution: Readonly<{
    readonly label: StockTokenTradeHistorySourceResolutionLabel;
    readonly member: StockTokenTradeHistoryStoredMemberIdentity;
    readonly coverage: readonly StockTokenTradeHistoryCoverageSegment[];
    readonly candles: readonly StockTokenTradeHistoryStoredCandle[];
  }>;
}

export interface StockTokenTradeHistoryAvailableSource {
  readonly status: "available";
  readonly observedAt: UtcTimestamp;
  readonly root: StockTokenTradeHistorySelectedRoot;
  readonly base: StockTokenTradeHistorySelectedBase;
  readonly ownerMonths: readonly StockTokenTradeHistorySelectedOwnerMonth[];
}

export type StockTokenTradeHistoryUnavailableSource =
  | Readonly<{
      readonly status: "unavailable";
      readonly reason: StockTokenTradeHistorySourceReason;
      readonly scope: "catalog_root";
      readonly observedAt: UtcTimestamp;
    }>
  | Readonly<{
      readonly status: "unavailable";
      readonly reason: StockTokenTradeHistorySourceReason;
      readonly scope: "selected_base";
      readonly observedAt: UtcTimestamp;
      readonly root: StockTokenTradeHistorySelectedRoot;
    }>
  | Readonly<{
      readonly status: "unavailable";
      readonly reason: StockTokenTradeHistorySourceReason;
      readonly scope: "selected_period";
      readonly observedAt: UtcTimestamp;
      readonly root: StockTokenTradeHistorySelectedRoot;
      readonly base: StockTokenTradeHistorySelectedBase;
    }>;

export type StockTokenTradeHistorySourceResult =
  | StockTokenTradeHistoryAvailableSource
  | StockTokenTradeHistoryUnavailableSource;

export interface StockTokenTradeHistorySourcePort {
  read(
    input: StockTokenTradeHistorySourceInput,
    signal?: AbortSignal,
  ): Promise<StockTokenTradeHistorySourceResult>;
  close(): Promise<void>;
}

const sourceRateLimitErrors = new WeakSet<object>();

export class StockTokenTradeHistorySourceRateLimitError extends Error {
  constructor() {
    super("The Stock Token trade-history source rate-limited the request.");
    this.name = "StockTokenTradeHistorySourceRateLimitError";
    sourceRateLimitErrors.add(this);
    Object.freeze(this);
  }
}

export const isStockTokenTradeHistorySourceRateLimitError = (
  value: unknown,
): value is StockTokenTradeHistorySourceRateLimitError =>
  typeof value === "object" && value !== null && sourceRateLimitErrors.has(value);

export class StockTokenTradeHistorySourceClosedError extends Error {
  constructor() {
    super("The Stock Token trade-history source is closed.");
    this.name = "StockTokenTradeHistorySourceClosedError";
    Object.freeze(this);
  }
}

export interface StockTokenTradeHistorySourceDependencies {
  readonly transport: StockTokenTradeHistoryProviderTransport;
  readonly now?: () => Date;
}

const providerCleanupErrors = new WeakSet<object>();

export class StockTokenTradeHistoryProviderCleanupError extends Error {
  constructor(failures: readonly unknown[]) {
    super("Stock Token trade-history provider cleanup failed.", {
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
    });
    this.name = "StockTokenTradeHistoryProviderCleanupError";
    providerCleanupErrors.add(this);
  }
}

export const isStockTokenTradeHistoryProviderCleanupError = (
  value: unknown,
): value is StockTokenTradeHistoryProviderCleanupError =>
  typeof value === "object" && value !== null && providerCleanupErrors.has(value);

export const parseStockTokenTradeHistorySourceInput = (
  value: unknown,
): StockTokenTradeHistorySourceInput =>
  stockTokenTradeHistorySourceInputSchema.parse(value) as StockTokenTradeHistorySourceInput;

export const parseStockTokenTradeHistorySourceObservedAt = (
  value: unknown,
): UtcTimestamp => wholeSecondTimestampSchema.parse(value) as UtcTimestamp;

export const stockTokenTradeHistorySourceInternalSchemas = Object.freeze({
  positiveSafeInteger,
  nonnegativeSafeInteger,
  wholeSecondTimestamp: wholeSecondTimestampSchema,
  minuteTimestamp: minuteTimestampSchema,
  utcMonth: utcMonthSchema,
  hexSha256: hexSha256Schema,
});
