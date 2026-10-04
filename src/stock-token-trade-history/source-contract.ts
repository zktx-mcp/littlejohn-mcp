import { z } from "zod";

import {
  deepFreezeValue,
  jsonObject,
  type UtcTimestamp,
} from "../core/index.js";
import {
  stockTokenTradeHistorySourceInputSchema,
  stockTokenTradeHistorySourceIdentity,
  stockTokenTradeHistorySourceShapeLimits,
  stockTokenTradeHistorySourceSemanticSchemas,
  type StockTokenTradeHistorySourceInput,
  type StockTokenTradeHistorySourceResult as SemanticSourceResult,
} from "./source-semantics.js";

export type { StockTokenTradeHistorySourceInput } from "./source-semantics.js";

export const stockTokenTradeHistoryProducerAdmission = deepFreezeValue({
  revision: stockTokenTradeHistorySourceIdentity.revision,
  publicContractReference:
    "https://github.com/zktx-mcp/robinhood-stock-token-index/blob/db2a56433a39701307353375217998373b50e02d/README.md",
  storageImplementationReference:
    "https://github.com/zktx-mcp/robinhood-stock-token-index/blob/db2a56433a39701307353375217998373b50e02d/collector/market-data-assets.mjs",
  maximumReleaseAssets: 1_000,
  maximumPhysicalAssetBytes: 430_563_600,
} as const);

const { positiveSafeInteger, wholeSecondTimestamp } =
  stockTokenTradeHistorySourceSemanticSchemas;

const stockTokenTradeHistorySourceLimitSchema = jsonObject({
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
    ...stockTokenTradeHistorySourceShapeLimits,
    concurrentMemberReads: 2,
    deadlineMilliseconds: 60_000,
  }),
) as StockTokenTradeHistorySourceLimits;

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

export interface StockTokenTradeHistorySourcePort {
  read(
    input: StockTokenTradeHistorySourceInput,
    signal?: AbortSignal,
  ): Promise<SemanticSourceResult>;
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
  readonly primaryFailure: unknown | undefined;
  readonly cleanupFailures: readonly unknown[];

  constructor(cleanupFailures: readonly unknown[], primaryFailure?: unknown) {
    if (cleanupFailures.length === 0) {
      throw new TypeError("Provider cleanup failure requires at least one cause.");
    }
    const retainedCleanup = Object.freeze([...cleanupFailures]);
    const failures = primaryFailure === undefined
      ? retainedCleanup
      : Object.freeze([primaryFailure, ...retainedCleanup]);
    super("Stock Token trade-history provider cleanup failed.", {
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
    });
    this.name = "StockTokenTradeHistoryProviderCleanupError";
    this.primaryFailure = primaryFailure;
    this.cleanupFailures = retainedCleanup;
    providerCleanupErrors.add(this);
    Object.freeze(this);
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
): UtcTimestamp => wholeSecondTimestamp.parse(value) as UtcTimestamp;
