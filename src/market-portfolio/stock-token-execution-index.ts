import { z } from "zod";

import {
  compareCodePointSequences,
  compareExactRationals,
  deepFreezeValue,
  evmAddressSchema,
  exactRationalSchema,
  hash32Schema,
  isWellFormedText,
  jsonObject,
  productChainId,
  productChainNumericId,
  sha256Bytes,
  unsignedDecimalSchema,
  utcTimestampSchema,
  type EvmAddress,
} from "../core/index.js";
import {
  stockTokenExecutionIndexRegistryJson,
  stockTokenExecutionIndexRegistrySourceSha256,
} from "./stock-token-execution-index-registry.generated.js";

export const stockTokenExecutionIndexRegistrySha256 =
  stockTokenExecutionIndexRegistrySourceSha256;

const sha256HexSchema = z.string().length(64).regex(/^[0-9a-f]{64}$/u);
const canonicalDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).superRefine((value, context) => {
  if (new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    context.addIssue({ code: "custom", message: "Expected a canonical UTC day." });
  }
});
const minuteTimestampSchema = utcTimestampSchema.superRefine((value, context) => {
  if (!value.endsWith(".000Z") || Date.parse(value) % 60_000 !== 0) {
    context.addIssue({ code: "custom", message: "Expected a minute-aligned UTC timestamp." });
  }
});
const boundedUnsignedDecimalSchema = unsignedDecimalSchema.refine(
  (value) => value.length <= 78,
  "Unsigned decimal exceeds the supported integer width.",
);

const executionIndexQuoteTokenSchema = jsonObject({
  address: evmAddressSchema,
  decimals: z.number().int().nonnegative().max(255),
  symbol: z.literal("USDG"),
}).strict();

const executionIndexAssetSchema = jsonObject({
  symbol: z.string().min(1).max(32).regex(/^[A-Z0-9][A-Z0-9.-]*$/u),
  name: z.string().min(1).max(256),
  token: evmAddressSchema,
  tokenDecimals: z.number().int().nonnegative().max(255),
  currency0: evmAddressSchema,
  currency1: evmAddressSchema,
  stockTokenIsCurrency0: z.boolean(),
  poolId: hash32Schema,
}).strict();

const executionIndexGroupSchema = jsonObject({
  groupId: z.string().regex(/^group-[0-9]{2}$/u),
  assets: z.array(executionIndexAssetSchema).min(1).max(8),
}).strict().superRefine((value, context) => {
  const symbols = new Set(value.assets.map((asset) => asset.symbol));
  const tokens = new Set(value.assets.map((asset) => asset.token));
  const pools = new Set(value.assets.map((asset) => asset.poolId));
  if (symbols.size !== value.assets.length || tokens.size !== value.assets.length || pools.size !== value.assets.length) {
    context.addIssue({ code: "custom", message: "Execution-index group identities are not unique." });
  }
});

const executionIndexRegistrySchema = jsonObject({
  contractVersion: z.literal("1"),
  chain: jsonObject({
    chainId: z.literal(productChainId),
    numericChainId: z.literal(productChainNumericId),
    defaultRpcUrl: z.literal("https://rpc.mainnet.chain.robinhood.com"),
    finalityTag: z.literal("finalized"),
  }).strict(),
  deployment: jsonObject({
    poolManager: evmAddressSchema,
    stateView: evmAddressSchema,
    quoteToken: executionIndexQuoteTokenSchema,
    swapTopic: hash32Schema,
    fee: z.literal(3_000),
    tickSpacing: z.literal(60),
    hooks: z.literal("0x0000000000000000000000000000000000000000"),
  }).strict(),
  collection: jsonObject({
    candleSeconds: z.literal(60),
    scheduleMinutes: z.tuple([z.literal(7), z.literal(22), z.literal(37), z.literal(52)]),
    initialLookbackSeconds: z.literal(3_600),
    repairLookbackSeconds: z.literal(21_600),
    logRangeBlocks: z.literal(2_000),
    maximumBlocksPerRun: z.literal(32_000),
    headerBatchSize: z.literal(100),
    requestDelayMilliseconds: z.literal(750),
    requestTimeoutMilliseconds: z.literal(30_000),
    maximumResponseBytes: z.literal(16_777_216),
    maximumArtifactBytes: z.literal(16_777_216),
    retentionDays: z.literal(365),
  }).strict(),
  groups: z.array(executionIndexGroupSchema).length(1),
}).strict().superRefine((value, context) => {
  for (const group of value.groups) {
    for (const asset of group.assets) {
      const expectedStockToken = asset.stockTokenIsCurrency0
        ? asset.currency0
        : asset.currency1;
      const expectedQuote = asset.stockTokenIsCurrency0
        ? asset.currency1
        : asset.currency0;
      if (asset.token !== expectedStockToken || expectedQuote !== value.deployment.quoteToken.address) {
        context.addIssue({
          code: "custom",
          message: "Execution-index PoolKey asset order is invalid.",
        });
      }
    }
  }
});

export const stockTokenExecutionIndexRegistry = deepFreezeValue(
  executionIndexRegistrySchema.parse(JSON.parse(stockTokenExecutionIndexRegistryJson) as unknown),
);
export type StockTokenExecutionIndexAsset = z.infer<typeof executionIndexAssetSchema>;

const executionIndexGroup = stockTokenExecutionIndexRegistry.groups[0]!;
const executionIndexAssetByToken = new Map<EvmAddress, StockTokenExecutionIndexAsset>(
  executionIndexGroup.assets.map((asset) => [asset.token, asset]),
);

export const findStockTokenExecutionIndexAsset = (
  token: EvmAddress,
): StockTokenExecutionIndexAsset | undefined => executionIndexAssetByToken.get(token);

export const stockTokenExecutionSourcePositionSchema = jsonObject({
  blockNumber: boundedUnsignedDecimalSchema,
  blockHash: hash32Schema,
  transactionIndex: z.number().int().nonnegative().safe(),
  transactionHash: hash32Schema,
  logIndex: z.number().int().nonnegative().safe(),
}).strict();
export type StockTokenExecutionSourcePosition =
  z.infer<typeof stockTokenExecutionSourcePositionSchema>;

const compareSourcePositions = (
  left: StockTokenExecutionSourcePosition,
  right: StockTokenExecutionSourcePosition,
): number => {
  const block = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (block !== 0n) return block < 0n ? -1 : 1;
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
};

export const stockTokenExecutionCandleSchema = jsonObject({
  symbol: executionIndexAssetSchema.shape.symbol,
  token: evmAddressSchema,
  poolId: hash32Schema,
  intervalStart: minuteTimestampSchema,
  intervalEnd: minuteTimestampSchema,
  open: exactRationalSchema,
  high: exactRationalSchema,
  low: exactRationalSchema,
  close: exactRationalSchema,
  tokenVolumeRaw: boundedUnsignedDecimalSchema.refine((value) => value !== "0"),
  quoteVolumeRaw: boundedUnsignedDecimalSchema.refine((value) => value !== "0"),
  tradeCount: z.number().int().positive().safe(),
  firstSource: stockTokenExecutionSourcePositionSchema,
  lastSource: stockTokenExecutionSourcePositionSchema,
}).strict().superRefine((value, context) => {
  if (
    Date.parse(value.intervalEnd) - Date.parse(value.intervalStart) !== 60_000 ||
    compareExactRationals(value.high, value.open) < 0 ||
    compareExactRationals(value.high, value.close) < 0 ||
    compareExactRationals(value.low, value.open) > 0 ||
    compareExactRationals(value.low, value.close) > 0 ||
    compareExactRationals(value.high, value.low) < 0 ||
    compareSourcePositions(value.firstSource, value.lastSource) > 0
  ) context.addIssue({ code: "custom", message: "Execution candle semantics are invalid." });
});
export type StockTokenExecutionCandle = z.infer<typeof stockTokenExecutionCandleSchema>;

export const stockTokenExecutionCoverageIntervalSchema = jsonObject({
  fromBlock: boundedUnsignedDecimalSchema,
  fromTimestamp: minuteTimestampSchema,
  untilBlock: boundedUnsignedDecimalSchema,
  untilTimestamp: minuteTimestampSchema,
}).strict().superRefine((value, context) => {
  if (
    BigInt(value.fromBlock) > BigInt(value.untilBlock) ||
    Date.parse(value.fromTimestamp) >= Date.parse(value.untilTimestamp)
  ) context.addIssue({ code: "custom", message: "Execution coverage interval is invalid." });
});
export type StockTokenExecutionCoverageInterval =
  z.infer<typeof stockTokenExecutionCoverageIntervalSchema>;

const daySourceSchema = jsonObject({
  chainId: z.literal(productChainId),
  finality: z.literal("finalized"),
  poolManager: evmAddressSchema,
  quoteToken: executionIndexQuoteTokenSchema,
  swapTopic: hash32Schema,
}).strict();

const maximumDayCandles = 1_440 * executionIndexGroup.assets.length;
const executionIndexDaySchema = jsonObject({
  contractVersion: z.literal("1"),
  kind: z.literal("stock_token_execution_day"),
  groupId: z.literal(executionIndexGroup.groupId),
  day: canonicalDaySchema,
  source: daySourceSchema,
  coverage: z.array(stockTokenExecutionCoverageIntervalSchema).length(1),
  candles: z.array(stockTokenExecutionCandleSchema).max(maximumDayCandles),
}).strict().superRefine((value, context) => {
  const expectedSource = {
    chainId: stockTokenExecutionIndexRegistry.chain.chainId,
    finality: stockTokenExecutionIndexRegistry.chain.finalityTag,
    poolManager: stockTokenExecutionIndexRegistry.deployment.poolManager,
    quoteToken: stockTokenExecutionIndexRegistry.deployment.quoteToken,
    swapTopic: stockTokenExecutionIndexRegistry.deployment.swapTopic,
  };
  if (JSON.stringify(value.source) !== JSON.stringify(expectedSource)) {
    context.addIssue({ code: "custom", message: "Execution day source differs from the registry." });
  }
  const assets = new Map(executionIndexGroup.assets.map((asset) => [asset.poolId, asset]));
  let previous: StockTokenExecutionCandle | undefined;
  for (const candle of value.candles) {
    const asset = assets.get(candle.poolId);
    const coverage = value.coverage[0]!;
    if (
      asset === undefined ||
      candle.symbol !== asset.symbol ||
      candle.token !== asset.token ||
      !candle.intervalStart.startsWith(value.day) ||
      candle.intervalStart < coverage.fromTimestamp ||
      candle.intervalEnd > coverage.untilTimestamp ||
      BigInt(candle.firstSource.blockNumber) < BigInt(coverage.fromBlock) ||
      BigInt(candle.lastSource.blockNumber) >= BigInt(coverage.untilBlock)
    ) context.addIssue({ code: "custom", message: "Execution candle is outside its registry or coverage." });
    if (previous !== undefined) {
      const order = compareCodePointSequences(previous.poolId, candle.poolId) ||
        compareCodePointSequences(previous.intervalStart, candle.intervalStart);
      if (order >= 0) {
        context.addIssue({ code: "custom", message: "Execution candles are not uniquely ordered." });
      }
    }
    previous = candle;
  }
});
export const stockTokenExecutionIndexDaySchema = executionIndexDaySchema;
export type StockTokenExecutionIndexDay = z.infer<typeof executionIndexDaySchema>;

export const stockTokenExecutionDayReferenceSchema = jsonObject({
  day: canonicalDaySchema,
  releaseTag: z.string().regex(/^index-[0-9]{4}-[0-9]{2}$/u),
  assetName: z.string().min(1).max(256),
  gzipBytes: z.number().int().positive().max(16_777_216),
  gzipSha256: sha256HexSchema,
  jsonBytes: z.number().int().positive().max(16_777_216),
  jsonSha256: sha256HexSchema,
}).strict();
export type StockTokenExecutionDayReference =
  z.infer<typeof stockTokenExecutionDayReferenceSchema>;

export interface StockTokenExecutionIndexDayAdmission {
  readonly reference: StockTokenExecutionDayReference;
  readonly day: StockTokenExecutionIndexDay;
  readonly sha256: string;
}

const executionIndexStateSchema = jsonObject({
  contractVersion: z.literal("1"),
  kind: z.literal("stock_token_execution_state"),
  groupId: z.literal(executionIndexGroup.groupId),
  sequence: z.number().int().positive().safe(),
  nextBlock: boundedUnsignedDecimalSchema,
  coveredUntilTimestamp: minuteTimestampSchema,
  days: z.array(stockTokenExecutionDayReferenceSchema).max(366),
}).strict().superRefine((value, context) => {
  let previousDay = "";
  for (const reference of value.days) {
    const match = reference.assetName.match(new RegExp(
      `^${executionIndexGroup.groupId}-${reference.day}-g([0-9]{16})-([0-9a-f]{64})\\.json\\.gz$`,
      "u",
    ));
    if (
      reference.day <= previousDay ||
      reference.releaseTag !== `index-${reference.day.slice(0, 7)}` ||
      match === null ||
      BigInt(match[1]!) > BigInt(value.sequence) ||
      match[2] !== reference.gzipSha256
    ) context.addIssue({ code: "custom", message: "Execution day reference identity is invalid." });
    previousDay = reference.day;
  }
});
export const stockTokenExecutionIndexStateSchema = executionIndexStateSchema;
export type StockTokenExecutionIndexState = z.infer<typeof executionIndexStateSchema>;

export const canonicalStockTokenExecutionIndexJson = (value: unknown, depth = 0): string => {
  if (depth > 32) throw new TypeError("Execution-index artifact nesting is excessive.");
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new TypeError("Execution-index artifact number is not a safe integer.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!isWellFormedText(value)) throw new TypeError("Execution-index artifact text is invalid.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > maximumDayCandles) {
      throw new TypeError("Execution-index artifact array exceeds its bound.");
    }
    return `[${value.map((member) => canonicalStockTokenExecutionIndexJson(member, depth + 1)).join(",")}]`;
  }
  if (typeof value !== "object") throw new TypeError("Execution-index artifact value is invalid.");
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort(compareCodePointSequences);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStockTokenExecutionIndexJson(object[key], depth + 1)}`).join(",")}}`;
};

export const stockTokenExecutionIndexUnavailableReasonSchema = z.enum([
  "asset_not_indexed",
  "index_unavailable",
  "index_inconsistent",
  "outside_published_coverage",
]);
export type StockTokenExecutionIndexUnavailableReason =
  z.infer<typeof stockTokenExecutionIndexUnavailableReasonSchema>;

export const stockTokenExecutionCoverageLimitationSchema = z.enum([
  "before_published_coverage",
  "after_published_coverage",
  "stale_index",
  "candle_capacity",
]);
export type StockTokenExecutionCoverageLimitation =
  z.infer<typeof stockTokenExecutionCoverageLimitationSchema>;

export const stockTokenExecutionSeriesLimits = Object.freeze({
  candles: 3_072,
  coverageIntervals: 32,
  dayArtifacts: 31,
  freshnessMilliseconds: 30 * 60 * 1_000,
  metadataResponseBytes: 2_097_152,
  artifactBytes: 16_777_216,
  requestDeadlineMilliseconds: 30_000,
});

const executionSeriesCommon = {
  requestedStart: utcTimestampSchema,
  requestedEnd: utcTimestampSchema,
} as const;

const executionSeriesUnavailableSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: stockTokenExecutionIndexUnavailableReasonSchema,
  ...executionSeriesCommon,
}).strict();

const executionSeriesAvailableSchema = jsonObject({
  status: z.literal("available"),
  ...executionSeriesCommon,
  source: jsonObject({
    chainId: z.literal(productChainId),
    finality: z.literal("finalized"),
    poolManager: evmAddressSchema,
    poolId: hash32Schema,
    quoteToken: executionIndexQuoteTokenSchema,
  }).strict(),
  artifact: jsonObject({
    contractVersion: z.literal("1"),
    groupId: z.literal(executionIndexGroup.groupId),
    sequence: z.number().int().positive().safe(),
    coveredUntilTimestamp: minuteTimestampSchema,
    stateSha256: sha256HexSchema,
    days: z.array(jsonObject({
      day: canonicalDaySchema,
      sha256: sha256HexSchema,
    }).strict()).min(1).max(stockTokenExecutionSeriesLimits.dayArtifacts),
  }).strict(),
  freshness: z.enum(["current", "stale"]),
  coverage: jsonObject({
    status: z.enum(["complete", "partial"]),
    intervals: z.array(stockTokenExecutionCoverageIntervalSchema)
      .min(1)
      .max(stockTokenExecutionSeriesLimits.coverageIntervals),
    limitations: z.array(stockTokenExecutionCoverageLimitationSchema)
      .max(stockTokenExecutionCoverageLimitationSchema.options.length),
    observedCandleCount: z.number().int().nonnegative().max(43_200),
  }).strict(),
  candles: z.array(stockTokenExecutionCandleSchema).max(stockTokenExecutionSeriesLimits.candles),
}).strict().superRefine((value, context) => {
  const asset = executionIndexGroup.assets.find((candidate) => candidate.poolId === value.source.poolId);
  if (
    asset === undefined ||
    value.source.poolManager !== stockTokenExecutionIndexRegistry.deployment.poolManager ||
    JSON.stringify(value.source.quoteToken) !==
      JSON.stringify(stockTokenExecutionIndexRegistry.deployment.quoteToken)
  ) context.addIssue({ code: "custom", message: "Execution series source differs from the registry." });
  const requestedStart = Date.parse(value.requestedStart);
  const requestedEnd = Date.parse(value.requestedEnd);
  let previousInterval: StockTokenExecutionCoverageInterval | undefined;
  for (const [index, interval] of value.coverage.intervals.entries()) {
    const start = Date.parse(interval.fromTimestamp);
    if (
      previousInterval !== undefined &&
      (start !== Date.parse(previousInterval.untilTimestamp) ||
        interval.fromBlock !== previousInterval.untilBlock)
    ) {
      context.addIssue({ code: "custom", message: "Execution coverage is not continuous." });
    }
    if (value.artifact.days[index]?.day !== interval.fromTimestamp.slice(0, 10)) {
      context.addIssue({ code: "custom", message: "Execution artifact day does not match its coverage." });
    }
    previousInterval = interval;
  }
  let previousCandle: StockTokenExecutionCandle | undefined;
  for (const candle of value.candles) {
    const candleStart = Date.parse(candle.intervalStart);
    const candleEnd = Date.parse(candle.intervalEnd);
    const covered = value.coverage.intervals.some((interval) =>
      candleStart >= Date.parse(interval.fromTimestamp) &&
      candleEnd <= Date.parse(interval.untilTimestamp) &&
      BigInt(candle.firstSource.blockNumber) >= BigInt(interval.fromBlock) &&
      BigInt(candle.lastSource.blockNumber) < BigInt(interval.untilBlock));
    if (
      asset === undefined ||
      candle.poolId !== asset.poolId ||
      candle.token !== asset.token ||
      candle.symbol !== asset.symbol ||
      candleStart < requestedStart ||
      candleEnd > requestedEnd ||
      !covered ||
      (previousCandle !== undefined &&
        (candle.intervalStart <= previousCandle.intervalStart ||
          compareSourcePositions(previousCandle.lastSource, candle.firstSource) >= 0))
    ) context.addIssue({ code: "custom", message: "Execution series candle membership is invalid." });
    previousCandle = candle;
  }
  const expected = new Set<StockTokenExecutionCoverageLimitation>();
  if (Date.parse(value.coverage.intervals[0]!.fromTimestamp) > requestedStart) {
    expected.add("before_published_coverage");
  }
  if (Date.parse(value.coverage.intervals.at(-1)!.untilTimestamp) < requestedEnd) {
    expected.add("after_published_coverage");
  }
  const stale = requestedEnd - Date.parse(value.artifact.coveredUntilTimestamp) >
    stockTokenExecutionSeriesLimits.freshnessMilliseconds;
  if (stale) expected.add("stale_index");
  if (value.coverage.observedCandleCount > stockTokenExecutionSeriesLimits.candles) {
    expected.add("candle_capacity");
  }
  const expectedLimitations = limitationOrder.filter((limitation) => expected.has(limitation));
  const expectedCoverageStatus = expectedLimitations.some((limitation) => limitation !== "stale_index")
    ? "partial"
    : "complete";
  if (
    requestedStart >= requestedEnd ||
    value.freshness !== (stale ? "stale" : "current") ||
    value.coverage.status !== expectedCoverageStatus ||
    value.coverage.limitations.join("\0") !== expectedLimitations.join("\0") ||
    value.artifact.days.length !== value.coverage.intervals.length ||
    (value.coverage.observedCandleCount <= stockTokenExecutionSeriesLimits.candles
      ? value.coverage.observedCandleCount !== value.candles.length
      : value.candles.length !== stockTokenExecutionSeriesLimits.candles) ||
    value.artifact.days.some((entry, index) => index > 0 &&
      entry.day <= value.artifact.days[index - 1]!.day) ||
    new Set(value.artifact.days.map((entry) => entry.sha256)).size !== value.artifact.days.length
  ) context.addIssue({ code: "custom", message: "Execution series projection is inconsistent." });
});

export const stockTokenExecutionSeriesSchema = z.discriminatedUnion("status", [
  executionSeriesUnavailableSchema,
  executionSeriesAvailableSchema,
]);
export type StockTokenExecutionSeries = z.infer<typeof stockTokenExecutionSeriesSchema>;

export interface StockTokenExecutionIndexReadInput {
  readonly token: EvmAddress;
  readonly requestedStart: string;
  readonly requestedEnd: string;
}

export interface StockTokenExecutionIndexReadPort {
  read(
    input: StockTokenExecutionIndexReadInput,
    signal?: AbortSignal,
  ): Promise<StockTokenExecutionSeries>;
}

const limitationOrder = stockTokenExecutionCoverageLimitationSchema.options;

export const createStockTokenExecutionSeries = (input: Readonly<{
  request: StockTokenExecutionIndexReadInput;
  asset: StockTokenExecutionIndexAsset;
  state: StockTokenExecutionIndexState;
  stateSha256: string;
  days: readonly StockTokenExecutionIndexDayAdmission[];
}>): StockTokenExecutionSeries => {
  const asset = executionIndexAssetSchema.parse(input.asset);
  const registeredAsset = findStockTokenExecutionIndexAsset(asset.token);
  if (registeredAsset === undefined || JSON.stringify(registeredAsset) !== JSON.stringify(asset)) {
    throw new TypeError("Execution-index asset differs from the admitted registry.");
  }
  const state = executionIndexStateSchema.parse(input.state);
  const stateSha256 = sha256HexSchema.parse(input.stateSha256);
  if (sha256Bytes(new TextEncoder().encode(canonicalStockTokenExecutionIndexJson(state))) !== stateSha256) {
    throw new TypeError("Execution-index state digest does not match its admitted value.");
  }
  if (evmAddressSchema.parse(input.request.token) !== asset.token) {
    throw new TypeError("Execution-index request and asset identities differ.");
  }
  const days = input.days.map((entry) => Object.freeze({
    reference: stockTokenExecutionDayReferenceSchema.parse(entry.reference),
    day: executionIndexDaySchema.parse(entry.day),
    sha256: sha256HexSchema.parse(entry.sha256),
  })).sort((left, right) => compareCodePointSequences(left.reference.day, right.reference.day));
  const request = {
    requestedStart: utcTimestampSchema.parse(input.request.requestedStart),
    requestedEnd: utcTimestampSchema.parse(input.request.requestedEnd),
  };
  const requestedStart = Date.parse(request.requestedStart);
  const requestedEnd = Date.parse(request.requestedEnd);
  if (requestedStart >= requestedEnd) throw new TypeError("Execution-index read interval is invalid.");
  for (const entry of days) {
    const retainedReference = state.days.find((candidate) =>
      candidate.day === entry.reference.day &&
      candidate.releaseTag === entry.reference.releaseTag &&
      candidate.assetName === entry.reference.assetName &&
      candidate.gzipBytes === entry.reference.gzipBytes &&
      candidate.gzipSha256 === entry.reference.gzipSha256 &&
      candidate.jsonBytes === entry.reference.jsonBytes &&
      candidate.jsonSha256 === entry.reference.jsonSha256);
    const coverage = entry.day.coverage[0]!;
    if (
      retainedReference === undefined ||
      entry.day.day !== entry.reference.day ||
      entry.sha256 !== entry.reference.jsonSha256 ||
      sha256Bytes(new TextEncoder().encode(canonicalStockTokenExecutionIndexJson(entry.day))) !== entry.sha256 ||
      Date.parse(coverage.untilTimestamp) > Date.parse(state.coveredUntilTimestamp) ||
      BigInt(coverage.untilBlock) > BigInt(state.nextBlock)
    ) throw new TypeError("Execution-index state and day admissions are not correlated.");
  }
  const usedDays = days.filter((entry) => {
    const interval = entry.day.coverage[0]!;
    return Date.parse(interval.untilTimestamp) > requestedStart &&
      Date.parse(interval.fromTimestamp) < requestedEnd;
  });
  const intervals = usedDays.map((entry) => entry.day.coverage[0]!)
    .sort((left, right) => compareCodePointSequences(left.fromTimestamp, right.fromTimestamp));
  if (intervals.length === 0) {
    return deepFreezeValue(stockTokenExecutionSeriesSchema.parse({
      status: "unavailable",
      reason: "outside_published_coverage",
      ...request,
    }));
  }
  const allCandles = usedDays.flatMap((entry) => entry.day.candles)
    .filter((candle) =>
      candle.poolId === asset.poolId &&
      Date.parse(candle.intervalStart) >= requestedStart &&
      Date.parse(candle.intervalEnd) <= requestedEnd)
    .sort((left, right) => compareCodePointSequences(left.intervalStart, right.intervalStart));
  const capacityLimited = allCandles.length > stockTokenExecutionSeriesLimits.candles;
  const candles = capacityLimited
    ? allCandles.slice(-stockTokenExecutionSeriesLimits.candles)
    : allCandles;
  const firstCoverage = Date.parse(intervals[0]!.fromTimestamp);
  const lastCoverage = Date.parse(intervals.at(-1)!.untilTimestamp);
  const stale = requestedEnd - Date.parse(state.coveredUntilTimestamp) >
    stockTokenExecutionSeriesLimits.freshnessMilliseconds;
  const limitations = new Set<StockTokenExecutionCoverageLimitation>();
  if (firstCoverage > requestedStart) limitations.add("before_published_coverage");
  if (lastCoverage < requestedEnd) limitations.add("after_published_coverage");
  if (stale) limitations.add("stale_index");
  if (capacityLimited) limitations.add("candle_capacity");
  const orderedLimitations = limitationOrder.filter((limitation) => limitations.has(limitation));
  return deepFreezeValue(stockTokenExecutionSeriesSchema.parse({
    status: "available",
    ...request,
    source: {
      chainId: stockTokenExecutionIndexRegistry.chain.chainId,
      finality: stockTokenExecutionIndexRegistry.chain.finalityTag,
      poolManager: stockTokenExecutionIndexRegistry.deployment.poolManager,
      poolId: asset.poolId,
      quoteToken: stockTokenExecutionIndexRegistry.deployment.quoteToken,
    },
    artifact: {
      contractVersion: state.contractVersion,
      groupId: state.groupId,
      sequence: state.sequence,
      coveredUntilTimestamp: state.coveredUntilTimestamp,
      stateSha256,
      days: usedDays.map((entry) => ({
        day: entry.reference.day,
        sha256: entry.sha256,
      })),
    },
    freshness: stale ? "stale" : "current",
    coverage: {
      status: orderedLimitations.some((limitation) => limitation !== "stale_index")
        ? "partial"
        : "complete",
      intervals,
      limitations: orderedLimitations,
      observedCandleCount: allCandles.length,
    },
    candles,
  }));
};

export const unavailableStockTokenExecutionSeries = (
  input: StockTokenExecutionIndexReadInput,
  reason: StockTokenExecutionIndexUnavailableReason,
): StockTokenExecutionSeries => deepFreezeValue(stockTokenExecutionSeriesSchema.parse({
  status: "unavailable",
  reason,
  requestedStart: input.requestedStart,
  requestedEnd: input.requestedEnd,
}));
