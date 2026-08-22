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
  keccak256FromHex,
  marketTimeWindowDefinitions,
  marketTimeWindowSchema,
  maximumMarketTimeWindowMilliseconds,
  productChainId,
  productChainNumericId,
  sha256Bytes,
  unsignedDecimalSchema,
  utcTimestampSchema,
  type EvmAddress,
  type MarketTimeWindow,
} from "../core/index.js";
import {
  stockTokenExecutionIndexRegistryJson,
  stockTokenExecutionIndexRegistrySourceSha256,
} from "./stock-token-execution-index-registry.generated.js";

export const stockTokenExecutionIndexRegistrySha256 =
  stockTokenExecutionIndexRegistrySourceSha256;

const nativeCurrency = "0x0000000000000000000000000000000000000000" as const;
const sha256HexSchema = z.string().length(64).regex(/^[0-9a-f]{64}$/u);
const canonicalMonthSchema = z.string().regex(/^\d{4}-\d{2}$/u).superRefine((value, context) => {
  if (new Date(`${value}-01T00:00:00.000Z`).toISOString().slice(0, 7) !== value) {
    context.addIssue({ code: "custom", message: "Expected a canonical UTC month." });
  }
});
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
const wholeSecondTimestampSchema = utcTimestampSchema.refine(
  (value) => value.endsWith(".000Z"),
  "Expected a canonical UTC timestamp at whole-second precision.",
);
const boundedUnsignedDecimalSchema = unsignedDecimalSchema.refine(
  (value) => value.length <= 78,
  "Unsigned decimal exceeds the supported integer width.",
);
const positiveSafeIntegerSchema = z.number().int().positive().safe();

export const stockTokenExecutionDisplayWindowDefinitions = deepFreezeValue({
  "1d": { intervalMilliseconds: 15 * 60_000, fullPositionCount: 96, maximumPositionCount: 97 },
  "7d": { intervalMilliseconds: 60 * 60_000, fullPositionCount: 168, maximumPositionCount: 169 },
  "30d": { intervalMilliseconds: 4 * 60 * 60_000, fullPositionCount: 180, maximumPositionCount: 181 },
} satisfies Readonly<Record<MarketTimeWindow, Readonly<{
  intervalMilliseconds: number;
  fullPositionCount: number;
  maximumPositionCount: number;
}>>>);

const maximumDisplaySourceCandlesPerPosition = 240n;
const maximumSourceCandleInteger = 10n ** 78n - 1n;
const maximumDisplayVolumeRaw = maximumDisplaySourceCandlesPerPosition * maximumSourceCandleInteger;
const maximumDisplayTradeCount = maximumDisplaySourceCandlesPerPosition * BigInt(Number.MAX_SAFE_INTEGER);
const unsignedDecimalAtMost = (value: string, maximum: bigint): boolean => {
  const maximumText = maximum.toString();
  return value.length < maximumText.length ||
    (value.length === maximumText.length && value <= maximumText);
};
const displayVolumeRawSchema = unsignedDecimalSchema.refine(
  (value) => value !== "0" && unsignedDecimalAtMost(value, maximumDisplayVolumeRaw),
  "Display aggregate volume exceeds its source-derived maximum.",
);
const displayTradeCountSchema = unsignedDecimalSchema.refine(
  (value) => value !== "0" && unsignedDecimalAtMost(value, maximumDisplayTradeCount),
  "Display aggregate trade count exceeds its source-derived maximum.",
);

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
    return `[${value.map((member) => canonicalStockTokenExecutionIndexJson(member, depth + 1)).join(",")}]`;
  }
  if (typeof value !== "object") throw new TypeError("Execution-index artifact value is invalid.");
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort(compareCodePointSequences);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStockTokenExecutionIndexJson(object[key], depth + 1)}`).join(",")}}`;
};

const canonicalEqual = (left: unknown, right: unknown): boolean =>
  canonicalStockTokenExecutionIndexJson(left) === canonicalStockTokenExecutionIndexJson(right);

const abiWord = (value: string | bigint, bytes: number): string => {
  const hex = typeof value === "bigint" ? value.toString(16) : value.slice(2);
  if (hex.length > bytes * 2) throw new TypeError("PoolKey value exceeds its ABI width.");
  return hex.padStart(64, "0");
};

const derivePoolId = (poolKey: Readonly<{
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}>): string => keccak256FromHex(`0x${[
  abiWord(poolKey.currency0, 20),
  abiWord(poolKey.currency1, 20),
  abiWord(BigInt(poolKey.fee), 3),
  abiWord(BigInt(poolKey.tickSpacing), 3),
  abiWord(poolKey.hooks, 20),
].join("")}`);

const subtractUtcCalendarMonths = (value: string, months: number): string => {
  const source = new Date(value);
  const absoluteMonth = source.getUTCFullYear() * 12 + source.getUTCMonth() - months;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month,
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
  )).toISOString();
};

const erc20AssetSchema = jsonObject({
  address: evmAddressSchema.refine((value) => value !== nativeCurrency),
  decimals: z.number().int().nonnegative().max(255),
  kind: z.literal("erc20"),
}).strict();
const nativeAssetSchema = jsonObject({
  currency: z.literal(nativeCurrency),
  decimals: z.literal(18),
  kind: z.literal("native"),
}).strict();
const pairAssetSchema = z.discriminatedUnion("kind", [erc20AssetSchema, nativeAssetSchema]);
const sourceInitializationSchema = jsonObject({
  blockNumber: boundedUnsignedDecimalSchema,
  timestamp: wholeSecondTimestampSchema,
}).strict();
const minuteBoundarySchema = jsonObject({
  blockNumber: boundedUnsignedDecimalSchema,
  timestamp: minuteTimestampSchema,
}).strict();
const activationBoundarySchema = minuteBoundarySchema.extend({ hash: hash32Schema }).strict();
const poolKeySchema = jsonObject({
  currency0: evmAddressSchema,
  currency1: evmAddressSchema,
  fee: z.number().int().positive().max(1_000_000),
  hooks: evmAddressSchema,
  tickSpacing: z.number().int().positive().max(8_388_607),
}).strict();
const pairDescriptorSchema = jsonObject({
  activation: activationBoundarySchema,
  baseAsset: pairAssetSchema,
  baseIsCurrency0: z.boolean(),
  chainId: z.literal(productChainId),
  finality: z.literal("finalized"),
  historyStart: minuteBoundarySchema,
  pairId: hash32Schema,
  poolKey: poolKeySchema,
  poolManager: evmAddressSchema,
  quoteAsset: erc20AssetSchema,
  sourceInitialization: sourceInitializationSchema,
  swapTopic: hash32Schema,
}).strict();
export type StockTokenExecutionPair = z.infer<typeof pairDescriptorSchema>;

const pairDisplaySchema = jsonObject({
  baseName: z.string().min(1).max(128),
  baseSymbol: z.string().min(1).max(16).regex(/^[A-Z][A-Z0-9.]*$/u),
  label: z.string().min(1).max(64),
  quoteName: z.string().min(1).max(128),
  quoteSymbol: z.literal("USDG"),
}).strict();
const pairEntrySchema = jsonObject({ display: pairDisplaySchema, pair: pairDescriptorSchema }).strict();
const collectionSchema = jsonObject({
  candleSeconds: z.literal(60),
  headerBatchSize: positiveSafeIntegerSchema.max(100),
  historyMonths: z.literal(12),
  logRangeBlocks: positiveSafeIntegerSchema,
  maximumArtifactBytes: positiveSafeIntegerSchema.max(16_777_216),
  maximumBlocksPerRun: positiveSafeIntegerSchema,
  maximumResponseBytes: positiveSafeIntegerSchema.max(16_777_216),
  maximumRpcAttempts: positiveSafeIntegerSchema.max(10),
  maximumRpcRetryDelayMilliseconds: positiveSafeIntegerSchema.max(300_000),
  repairLookbackSeconds: positiveSafeIntegerSchema,
  requestDelayMilliseconds: positiveSafeIntegerSchema,
  requestTimeoutMilliseconds: positiveSafeIntegerSchema,
}).strict();
const registrySchema = jsonObject({
  chain: jsonObject({
    chainId: z.literal(productChainId),
    finalityTag: z.literal("finalized"),
    numericChainId: z.literal(productChainNumericId),
    primaryRpcUrl: z.literal("https://rpc.mainnet.chain.robinhood.com"),
  }).strict(),
  collection: collectionSchema,
  deployment: jsonObject({
    poolManager: evmAddressSchema,
    stateView: evmAddressSchema,
    swapTopic: hash32Schema,
  }).strict(),
  pairs: z.array(pairEntrySchema).length(9),
}).strict().superRefine((registry, context) => {
  const pairIds = new Set<string>();
  const currencies = new Map<string, string>();
  let previousPairId = "";
  let nativePairs = 0;
  for (const { display, pair } of registry.pairs) {
    const baseCurrency = pair.baseAsset.kind === "erc20" ? pair.baseAsset.address : pair.baseAsset.currency;
    const orientedBase = pair.baseIsCurrency0 ? pair.poolKey.currency0 : pair.poolKey.currency1;
    const orientedQuote = pair.baseIsCurrency0 ? pair.poolKey.currency1 : pair.poolKey.currency0;
    const initializationFloor = new Date(
      Math.floor(Date.parse(pair.sourceInitialization.timestamp) / 60_000) * 60_000,
    ).toISOString();
    const calendarCutoff = subtractUtcCalendarMonths(
      pair.activation.timestamp,
      registry.collection.historyMonths,
    );
    const expectedHistoryTimestamp = initializationFloor > calendarCutoff
      ? initializationFloor : calendarCutoff;
    if (
      pair.pairId <= previousPairId || pairIds.has(pair.pairId) ||
      BigInt(pair.poolKey.currency0) >= BigInt(pair.poolKey.currency1) ||
      orientedBase !== baseCurrency || orientedQuote !== pair.quoteAsset.address ||
      pair.poolManager !== registry.deployment.poolManager ||
      pair.swapTopic !== registry.deployment.swapTopic || derivePoolId(pair.poolKey) !== pair.pairId ||
      display.label !== `${display.baseSymbol}/${display.quoteSymbol}` ||
      BigInt(pair.sourceInitialization.blockNumber) > BigInt(pair.historyStart.blockNumber) ||
      BigInt(pair.historyStart.blockNumber) > BigInt(pair.activation.blockNumber) ||
      Date.parse(pair.sourceInitialization.timestamp) > Date.parse(pair.historyStart.timestamp) + 59_999 ||
      Date.parse(pair.historyStart.timestamp) > Date.parse(pair.activation.timestamp) ||
      pair.historyStart.timestamp !== expectedHistoryTimestamp ||
      (initializationFloor >= calendarCutoff &&
        pair.historyStart.blockNumber !== pair.sourceInitialization.blockNumber)
    ) {
      context.addIssue({ code: "custom", message: "Execution-index pair registry is inconsistent." });
    }
    const baseFacts = `${pair.baseAsset.decimals}:${display.baseSymbol}:${display.baseName}`;
    const quoteFacts = `${pair.quoteAsset.decimals}:${display.quoteSymbol}:${display.quoteName}`;
    if (
      (currencies.has(baseCurrency) && currencies.get(baseCurrency) !== baseFacts) ||
      (currencies.has(pair.quoteAsset.address) && currencies.get(pair.quoteAsset.address) !== quoteFacts)
    ) context.addIssue({ code: "custom", message: "Execution-index asset facts conflict." });
    currencies.set(baseCurrency, baseFacts);
    currencies.set(pair.quoteAsset.address, quoteFacts);
    if (pair.baseAsset.kind === "native") nativePairs += 1;
    pairIds.add(pair.pairId);
    previousPairId = pair.pairId;
  }
  if (nativePairs !== 1) context.addIssue({ code: "custom", message: "Expected one native registry pair." });
});

export const stockTokenExecutionIndexRegistry = deepFreezeValue(
  registrySchema.parse(JSON.parse(stockTokenExecutionIndexRegistryJson) as unknown),
);
export const stockTokenExecutionArtifactMaximumBytes =
  stockTokenExecutionIndexRegistry.collection.maximumArtifactBytes;

const executionIndexQuoteTokenSchema = jsonObject({
  address: evmAddressSchema,
  decimals: z.number().int().nonnegative().max(255),
  symbol: z.literal("USDG"),
}).strict();
const executionIndexAssetSchema = jsonObject({
  symbol: pairDisplaySchema.shape.baseSymbol,
  name: pairDisplaySchema.shape.baseName,
  token: evmAddressSchema,
  tokenDecimals: z.number().int().nonnegative().max(255),
  currency0: evmAddressSchema,
  currency1: evmAddressSchema,
  stockTokenIsCurrency0: z.boolean(),
  poolId: hash32Schema,
  pair: pairDescriptorSchema,
}).strict();
export type StockTokenExecutionIndexAsset = z.infer<typeof executionIndexAssetSchema>;

const supportedAssets = stockTokenExecutionIndexRegistry.pairs
  .filter((entry) => entry.pair.baseAsset.kind === "erc20")
  .map((entry) => {
    if (entry.pair.baseAsset.kind !== "erc20") throw new TypeError("Expected an ERC-20 pair.");
    return executionIndexAssetSchema.parse({
      symbol: entry.display.baseSymbol,
      name: entry.display.baseName,
      token: entry.pair.baseAsset.address,
      tokenDecimals: entry.pair.baseAsset.decimals,
      currency0: entry.pair.poolKey.currency0,
      currency1: entry.pair.poolKey.currency1,
      stockTokenIsCurrency0: entry.pair.baseIsCurrency0,
      poolId: entry.pair.pairId,
      pair: entry.pair,
    });
  });
if (supportedAssets.length !== 8) throw new TypeError("Expected eight Stock Token execution pairs.");
const executionIndexAssetByToken = new Map<EvmAddress, StockTokenExecutionIndexAsset>(
  supportedAssets.map((asset) => [asset.token, asset]),
);
const executionIndexAssetByPairId = new Map<string, StockTokenExecutionIndexAsset>(
  supportedAssets.map((asset) => [asset.poolId, asset]),
);

export const findStockTokenExecutionIndexAsset = (
  token: EvmAddress,
): StockTokenExecutionIndexAsset | undefined => executionIndexAssetByToken.get(token);
export const findStockTokenExecutionIndexAssetByPairId = (
  pairId: string,
): StockTokenExecutionIndexAsset | undefined => executionIndexAssetByPairId.get(pairId);

export const stockTokenExecutionSwapPositionSchema = jsonObject({
  blockNumber: boundedUnsignedDecimalSchema,
  blockHash: hash32Schema,
  transactionIndex: z.number().int().nonnegative().safe(),
  transactionHash: hash32Schema,
  logIndex: z.number().int().nonnegative().safe(),
}).strict();
export type StockTokenExecutionSwapPosition = z.infer<typeof stockTokenExecutionSwapPositionSchema>;

const compareSwapPositions = (
  left: StockTokenExecutionSwapPosition,
  right: StockTokenExecutionSwapPosition,
): number => {
  const block = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (block !== 0n) return block < 0n ? -1 : 1;
  if (left.transactionIndex !== right.transactionIndex) return left.transactionIndex - right.transactionIndex;
  return left.logIndex - right.logIndex;
};
const sameSwapPosition = (
  left: StockTokenExecutionSwapPosition,
  right: StockTokenExecutionSwapPosition,
): boolean => canonicalEqual(left, right);

interface SwapPositionIdentityState {
  readonly blockHashByNumber: Map<string, string>;
  readonly blockNumberByHash: Map<string, string>;
  readonly transactionHashByCoordinate: Map<string, string>;
  readonly transactionCoordinateByHash: Map<string, string>;
}
const createSwapPositionIdentityState = (): SwapPositionIdentityState => ({
  blockHashByNumber: new Map(),
  blockNumberByHash: new Map(),
  transactionHashByCoordinate: new Map(),
  transactionCoordinateByHash: new Map(),
});
const recordSwapPositionIdentity = (
  state: SwapPositionIdentityState,
  position: StockTokenExecutionSwapPosition,
): boolean => {
  const coordinate = `${position.blockNumber}:${position.transactionIndex}`;
  const conflict =
    (state.blockHashByNumber.has(position.blockNumber) &&
      state.blockHashByNumber.get(position.blockNumber) !== position.blockHash) ||
    (state.blockNumberByHash.has(position.blockHash) &&
      state.blockNumberByHash.get(position.blockHash) !== position.blockNumber) ||
    (state.transactionHashByCoordinate.has(coordinate) &&
      state.transactionHashByCoordinate.get(coordinate) !== position.transactionHash) ||
    (state.transactionCoordinateByHash.has(position.transactionHash) &&
      state.transactionCoordinateByHash.get(position.transactionHash) !== coordinate);
  state.blockHashByNumber.set(position.blockNumber, position.blockHash);
  state.blockNumberByHash.set(position.blockHash, position.blockNumber);
  state.transactionHashByCoordinate.set(coordinate, position.transactionHash);
  state.transactionCoordinateByHash.set(position.transactionHash, coordinate);
  return conflict;
};

const candleCoreShape = {
  intervalStart: minuteTimestampSchema,
  intervalEnd: minuteTimestampSchema,
  open: exactRationalSchema,
  high: exactRationalSchema,
  low: exactRationalSchema,
  close: exactRationalSchema,
  quoteVolumeRaw: boundedUnsignedDecimalSchema.refine((value) => value !== "0"),
  tradeCount: positiveSafeIntegerSchema,
  firstSource: stockTokenExecutionSwapPositionSchema,
  lastSource: stockTokenExecutionSwapPositionSchema,
} as const;

type ExactOhlc = Readonly<{
  open: z.infer<typeof exactRationalSchema>;
  high: z.infer<typeof exactRationalSchema>;
  low: z.infer<typeof exactRationalSchema>;
  close: z.infer<typeof exactRationalSchema>;
}>;

const invalidExactOhlc = (value: ExactOhlc): boolean =>
  compareExactRationals(value.high, value.open) < 0 ||
  compareExactRationals(value.high, value.close) < 0 ||
  compareExactRationals(value.low, value.open) > 0 ||
  compareExactRationals(value.low, value.close) > 0 ||
  compareExactRationals(value.high, value.low) < 0;

const invalidSwapBoundaryRange = (
  first: StockTokenExecutionSwapPosition,
  last: StockTokenExecutionSwapPosition,
  singleTrade: boolean,
): boolean => {
  const swapOrder = compareSwapPositions(first, last);
  const sameSwap = sameSwapPosition(first, last);
  const sameBlock = first.blockNumber === last.blockNumber;
  const sameTransaction = sameBlock && first.transactionIndex === last.transactionIndex;
  return swapOrder > 0 ||
    (sameBlock && first.blockHash !== last.blockHash) ||
    (!sameBlock && first.blockHash === last.blockHash) ||
    (sameTransaction && first.transactionHash !== last.transactionHash) ||
    (!sameTransaction && first.transactionHash === last.transactionHash) ||
    (sameBlock && swapOrder < 0 && first.logIndex >= last.logIndex) ||
    singleTrade !== sameSwap;
};

const validateCandle = (
  value: Readonly<z.infer<ReturnType<typeof jsonObject<typeof candleCoreShape>>>> & {
    readonly firstSource: StockTokenExecutionSwapPosition;
    readonly lastSource: StockTokenExecutionSwapPosition;
  },
  context: z.RefinementCtx,
): void => {
  if (
    Date.parse(value.intervalEnd) - Date.parse(value.intervalStart) !== 60_000 ||
    invalidExactOhlc(value) ||
    invalidSwapBoundaryRange(value.firstSource, value.lastSource, value.tradeCount === 1)
  ) context.addIssue({ code: "custom", message: "Execution candle semantics are invalid." });
};

const artifactCandleObjectSchema = jsonObject({
  ...candleCoreShape,
  baseVolumeRaw: boundedUnsignedDecimalSchema.refine((value) => value !== "0"),
}).strict();
export const stockTokenExecutionArtifactCandleSchema = artifactCandleObjectSchema.superRefine(validateCandle);
export type StockTokenExecutionArtifactCandle = z.infer<typeof stockTokenExecutionArtifactCandleSchema>;

const normalizedCandleObjectSchema = jsonObject({
  symbol: executionIndexAssetSchema.shape.symbol,
  token: evmAddressSchema,
  poolId: hash32Schema,
  ...candleCoreShape,
  tokenVolumeRaw: boundedUnsignedDecimalSchema.refine((value) => value !== "0"),
}).strict();
export const stockTokenExecutionCandleSchema = normalizedCandleObjectSchema.superRefine(validateCandle);
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
export type StockTokenExecutionCoverageInterval = z.infer<typeof stockTokenExecutionCoverageIntervalSchema>;

const executionDisplaySourceSchema = jsonObject({
  chainId: z.literal(productChainId),
  finality: z.literal("finalized"),
  poolManager: evmAddressSchema,
  poolId: hash32Schema,
  token: jsonObject({
    address: evmAddressSchema,
    decimals: z.number().int().nonnegative().max(255),
    symbol: executionIndexAssetSchema.shape.symbol,
  }).strict(),
  quoteToken: executionIndexQuoteTokenSchema,
}).strict();

const executionDisplayCandleObjectSchema = jsonObject({
  open: exactRationalSchema,
  high: exactRationalSchema,
  low: exactRationalSchema,
  close: exactRationalSchema,
  tokenVolumeRaw: displayVolumeRawSchema,
  quoteVolumeRaw: displayVolumeRawSchema,
  tradeCount: displayTradeCountSchema,
  firstSource: stockTokenExecutionSwapPositionSchema,
  lastSource: stockTokenExecutionSwapPositionSchema,
  observedStart: minuteTimestampSchema,
  observedEnd: minuteTimestampSchema,
}).strict();
export const stockTokenExecutionDisplayCandleSchema = executionDisplayCandleObjectSchema.superRefine(
  (value, context) => {
    const maximumSourceCandleCount = BigInt(
      (Date.parse(value.observedEnd) - Date.parse(value.observedStart)) / 60_000,
    );
    if (
      value.observedStart >= value.observedEnd ||
      invalidExactOhlc(value) ||
      invalidSwapBoundaryRange(value.firstSource, value.lastSource, value.tradeCount === "1") ||
      !unsignedDecimalAtMost(
        value.tokenVolumeRaw,
        maximumSourceCandleCount * maximumSourceCandleInteger,
      ) ||
      !unsignedDecimalAtMost(
        value.quoteVolumeRaw,
        maximumSourceCandleCount * maximumSourceCandleInteger,
      ) ||
      !unsignedDecimalAtMost(
        value.tradeCount,
        maximumSourceCandleCount * BigInt(Number.MAX_SAFE_INTEGER),
      )
    ) context.addIssue({ code: "custom", message: "Execution display candle semantics are invalid." });
  },
);
export type StockTokenExecutionDisplayCandle = z.infer<
  typeof stockTokenExecutionDisplayCandleSchema
>;

export const stockTokenExecutionDisplayPositionCoverageSchema = z.enum([
  "complete",
  "partial",
  "unavailable",
]);
export type StockTokenExecutionDisplayPositionCoverage = z.infer<
  typeof stockTokenExecutionDisplayPositionCoverageSchema
>;

const executionDisplayPositionSchema = jsonObject({
  intervalStart: minuteTimestampSchema,
  intervalEnd: minuteTimestampSchema,
  representedStart: utcTimestampSchema,
  representedEnd: utcTimestampSchema,
  coverage: stockTokenExecutionDisplayPositionCoverageSchema,
  candle: stockTokenExecutionDisplayCandleSchema.nullable(),
}).strict();
export type StockTokenExecutionDisplayPosition = z.infer<typeof executionDisplayPositionSchema>;

interface ExecutionDisplayPositionFrame {
  readonly intervalStart: string;
  readonly intervalEnd: string;
  readonly representedStart: string;
  readonly representedEnd: string;
}

const executionDisplayPositionFrames = (
  window: MarketTimeWindow,
  requestedStart: string,
  requestedEnd: string,
): readonly ExecutionDisplayPositionFrame[] => {
  const definition = stockTokenExecutionDisplayWindowDefinitions[window];
  const requestedStartTime = Date.parse(requestedStart);
  const requestedEndTime = Date.parse(requestedEnd);
  let intervalStart = Math.floor(requestedStartTime / definition.intervalMilliseconds) *
    definition.intervalMilliseconds;
  const frames: ExecutionDisplayPositionFrame[] = [];
  while (intervalStart < requestedEndTime) {
    const intervalEnd = intervalStart + definition.intervalMilliseconds;
    frames.push({
      intervalStart: new Date(intervalStart).toISOString(),
      intervalEnd: new Date(intervalEnd).toISOString(),
      representedStart: new Date(Math.max(intervalStart, requestedStartTime)).toISOString(),
      representedEnd: new Date(Math.min(intervalEnd, requestedEndTime)).toISOString(),
    });
    intervalStart = intervalEnd;
  }
  return frames;
};

const executionDisplaySeriesObjectSchema = jsonObject({
  window: marketTimeWindowSchema,
  requestedStart: utcTimestampSchema,
  requestedEnd: utcTimestampSchema,
  source: executionDisplaySourceSchema,
  positions: z.array(executionDisplayPositionSchema)
    .min(stockTokenExecutionDisplayWindowDefinitions["1d"].fullPositionCount)
    .max(stockTokenExecutionDisplayWindowDefinitions["30d"].maximumPositionCount),
}).strict();
export const stockTokenExecutionDisplaySeriesSchema = executionDisplaySeriesObjectSchema.superRefine(
  (value, context) => {
    const definition = stockTokenExecutionDisplayWindowDefinitions[value.window];
    if (
      Date.parse(value.requestedEnd) - Date.parse(value.requestedStart) !==
        marketTimeWindowDefinitions[value.window].durationMilliseconds
    ) {
      context.addIssue({ code: "custom", message: "Execution display request does not match its window." });
      return;
    }
    const asset = findStockTokenExecutionIndexAssetByPairId(value.source.poolId);
    if (
      asset === undefined || value.source.chainId !== asset.pair.chainId ||
      value.source.finality !== asset.pair.finality ||
      value.source.poolManager !== asset.pair.poolManager ||
      value.source.token.address !== asset.token ||
      value.source.token.decimals !== asset.tokenDecimals ||
      value.source.token.symbol !== asset.symbol ||
      value.source.quoteToken.address !== asset.pair.quoteAsset.address ||
      value.source.quoteToken.decimals !== asset.pair.quoteAsset.decimals
    ) context.addIssue({ code: "custom", message: "Execution display source differs from its pair." });
    const expected = executionDisplayPositionFrames(
      value.window,
      value.requestedStart,
      value.requestedEnd,
    );
    if (
      expected.length > definition.maximumPositionCount ||
      value.positions.length !== expected.length
    ) {
      context.addIssue({ code: "custom", message: "Execution display position count is invalid." });
      return;
    }
    let previousCandle: StockTokenExecutionDisplayCandle | undefined;
    const identities = createSwapPositionIdentityState();
    for (let index = 0; index < value.positions.length; index += 1) {
      const position = value.positions[index]!;
      const frame = expected[index]!;
      if (
        position.intervalStart !== frame.intervalStart ||
        position.intervalEnd !== frame.intervalEnd ||
        position.representedStart !== frame.representedStart ||
        position.representedEnd !== frame.representedEnd ||
        (position.coverage === "unavailable" && position.candle !== null)
      ) context.addIssue({ code: "custom", message: "Execution display position is inconsistent." });
      const candle = position.candle;
      if (candle === null) continue;
      if (
        candle.observedStart < position.representedStart ||
        candle.observedEnd > position.representedEnd ||
        (previousCandle !== undefined && (
          candle.observedStart <= previousCandle.observedStart ||
          compareSwapPositions(previousCandle.lastSource, candle.firstSource) >= 0
        ))
      ) context.addIssue({ code: "custom", message: "Execution display candle membership is invalid." });
      for (const source of [candle.firstSource, candle.lastSource]) {
        if (recordSwapPositionIdentity(identities, source)) {
          context.addIssue({ code: "custom", message: "Execution display Swap positions conflict." });
        }
      }
      previousCandle = candle;
    }
  },
);
export type StockTokenExecutionDisplaySeries = z.infer<
  typeof stockTokenExecutionDisplaySeriesSchema
>;

export const stockTokenExecutionArtifactReferenceSchema = jsonObject({
  coverage: stockTokenExecutionCoverageIntervalSchema,
  gzipBytes: positiveSafeIntegerSchema.max(stockTokenExecutionArtifactMaximumBytes),
  gzipSha256: sha256HexSchema,
  jsonBytes: positiveSafeIntegerSchema.max(stockTokenExecutionArtifactMaximumBytes),
  jsonSha256: sha256HexSchema,
  logicalId: z.string().min(1).max(256),
  sequence: positiveSafeIntegerSchema,
}).strict().superRefine((reference, context) => {
  const match = reference.logicalId.match(/^pairs\/(0x[0-9a-f]{64})\/(months|days)\/(.+)$/u);
  if (match === null) {
    context.addIssue({ code: "custom", message: "Execution artifact logical identity is invalid." });
    return;
  }
  const [, , kind, period] = match;
  const start = kind === "months" ? `${period}-01T00:00:00.000Z` : `${period}T00:00:00.000Z`;
  const startTime = Date.parse(start);
  if (
    !Number.isFinite(startTime) ||
    (kind === "months" ? !/^\d{4}-\d{2}$/u.test(period!) : !/^\d{4}-\d{2}-\d{2}$/u.test(period!))
  ) {
    context.addIssue({ code: "custom", message: "Execution artifact period is invalid." });
    return;
  }
  const until = new Date(startTime);
  if (kind === "months") until.setUTCMonth(until.getUTCMonth() + 1);
  else until.setUTCDate(until.getUTCDate() + 1);
  if (reference.coverage.fromTimestamp < start || reference.coverage.untilTimestamp > until.toISOString()) {
    context.addIssue({ code: "custom", message: "Execution artifact coverage escapes its period." });
  }
});
export type StockTokenExecutionArtifactReference = z.infer<typeof stockTokenExecutionArtifactReferenceSchema>;
export type StockTokenExecutionMonthReference = StockTokenExecutionArtifactReference;
export type StockTokenExecutionDayReference = StockTokenExecutionArtifactReference;

export const stockTokenExecutionPairStateLogicalId = (pairId: string): string => `pairs/${pairId}/state`;
export const stockTokenExecutionPairMonthLogicalId = (pairId: string, month: string): string =>
  `pairs/${pairId}/months/${month}`;
export const stockTokenExecutionPairDayLogicalId = (pairId: string, day: string): string =>
  `pairs/${pairId}/days/${day}`;

const intersectedPeriods = (from: string, until: string, size: "month" | "day"): readonly string[] => {
  const values: string[] = [];
  const cursor = new Date(from);
  if (size === "month") cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() < Date.parse(until)) {
    values.push(cursor.toISOString().slice(0, size === "month" ? 7 : 10));
    if (size === "month") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return values;
};

const validateOrderedReferences = (
  references: readonly StockTokenExecutionArtifactReference[],
  expectedLogicalIds: readonly string[],
  ownerSequence: number,
  ownerCoverage: StockTokenExecutionCoverageInterval,
  context: z.RefinementCtx,
): void => {
  if (references.length !== expectedLogicalIds.length) {
    context.addIssue({ code: "custom", message: "Execution references do not cover their owner." });
    return;
  }
  let block = ownerCoverage.fromBlock;
  let timestamp = ownerCoverage.fromTimestamp;
  let includesOwnerGeneration = false;
  references.forEach((reference, index) => {
    if (
      reference.logicalId !== expectedLogicalIds[index] || reference.sequence > ownerSequence ||
      reference.coverage.fromBlock !== block || reference.coverage.fromTimestamp !== timestamp
    ) context.addIssue({ code: "custom", message: "Execution reference order or coverage is inconsistent." });
    if (reference.sequence === ownerSequence) includesOwnerGeneration = true;
    block = reference.coverage.untilBlock;
    timestamp = reference.coverage.untilTimestamp;
  });
  if (
    block !== ownerCoverage.untilBlock || timestamp !== ownerCoverage.untilTimestamp || !includesOwnerGeneration
  ) context.addIssue({ code: "custom", message: "Execution references do not close their owner generation." });
};

const pairStateObjectSchema = jsonObject({
  contractVersion: z.literal("1"),
  coverage: stockTokenExecutionCoverageIntervalSchema,
  kind: z.literal("pair_candle_state"),
  months: z.array(stockTokenExecutionArtifactReferenceSchema).min(1),
  pair: pairDescriptorSchema,
  sequence: positiveSafeIntegerSchema,
}).strict();
export const stockTokenExecutionIndexStateSchema = pairStateObjectSchema.superRefine((value, context) => {
  const entry = stockTokenExecutionIndexRegistry.pairs.find((candidate) => candidate.pair.pairId === value.pair.pairId);
  if (
    entry === undefined || !canonicalEqual(entry.pair, value.pair) ||
    BigInt(value.coverage.fromBlock) < BigInt(value.pair.historyStart.blockNumber) ||
    BigInt(value.coverage.fromBlock) > BigInt(value.pair.activation.blockNumber) ||
    BigInt(value.coverage.untilBlock) < BigInt(value.pair.activation.blockNumber) ||
    value.coverage.fromTimestamp < value.pair.historyStart.timestamp ||
    value.coverage.fromTimestamp > value.pair.activation.timestamp ||
    value.coverage.untilTimestamp < value.pair.activation.timestamp
  ) context.addIssue({ code: "custom", message: "Execution state identity or coverage is invalid." });
  validateOrderedReferences(
    value.months,
    intersectedPeriods(value.coverage.fromTimestamp, value.coverage.untilTimestamp, "month")
      .map((month) => stockTokenExecutionPairMonthLogicalId(value.pair.pairId, month)),
    value.sequence,
    value.coverage,
    context,
  );
});
export type StockTokenExecutionIndexState = z.infer<typeof stockTokenExecutionIndexStateSchema>;

const pairMonthObjectSchema = jsonObject({
  contractVersion: z.literal("1"),
  coverage: stockTokenExecutionCoverageIntervalSchema,
  days: z.array(stockTokenExecutionArtifactReferenceSchema).min(1).max(31),
  kind: z.literal("pair_candle_month"),
  month: canonicalMonthSchema,
  pair: pairDescriptorSchema,
  sequence: positiveSafeIntegerSchema,
}).strict();
export const stockTokenExecutionIndexMonthSchema = pairMonthObjectSchema.superRefine((value, context) => {
  const entry = stockTokenExecutionIndexRegistry.pairs.find((candidate) => candidate.pair.pairId === value.pair.pairId);
  const monthStart = `${value.month}-01T00:00:00.000Z`;
  const monthUntil = new Date(monthStart);
  monthUntil.setUTCMonth(monthUntil.getUTCMonth() + 1);
  if (
    entry === undefined || !canonicalEqual(entry.pair, value.pair) ||
    value.coverage.fromTimestamp < monthStart || value.coverage.untilTimestamp > monthUntil.toISOString()
  ) context.addIssue({ code: "custom", message: "Execution month identity or coverage is invalid." });
  validateOrderedReferences(
    value.days,
    intersectedPeriods(value.coverage.fromTimestamp, value.coverage.untilTimestamp, "day")
      .map((day) => stockTokenExecutionPairDayLogicalId(value.pair.pairId, day)),
    value.sequence,
    value.coverage,
    context,
  );
});
export type StockTokenExecutionIndexMonth = z.infer<typeof stockTokenExecutionIndexMonthSchema>;

const pairDayObjectSchema = jsonObject({
  candles: z.array(stockTokenExecutionArtifactCandleSchema).max(1_440),
  contractVersion: z.literal("1"),
  coverage: stockTokenExecutionCoverageIntervalSchema,
  day: canonicalDaySchema,
  kind: z.literal("pair_candle_day"),
  pair: pairDescriptorSchema,
  sequence: positiveSafeIntegerSchema,
}).strict();
export const stockTokenExecutionIndexDaySchema = pairDayObjectSchema.superRefine((value, context) => {
  const entry = stockTokenExecutionIndexRegistry.pairs.find((candidate) => candidate.pair.pairId === value.pair.pairId);
  const dayStart = `${value.day}T00:00:00.000Z`;
  const dayUntil = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  if (
    entry === undefined || !canonicalEqual(entry.pair, value.pair) ||
    value.coverage.fromTimestamp < dayStart || value.coverage.untilTimestamp > dayUntil
  ) context.addIssue({ code: "custom", message: "Execution day identity or coverage is invalid." });
  let previous: StockTokenExecutionArtifactCandle | undefined;
  const identities = createSwapPositionIdentityState();
  for (const candle of value.candles) {
    if (
      !candle.intervalStart.startsWith(value.day) ||
      candle.intervalStart < value.coverage.fromTimestamp || candle.intervalEnd > value.coverage.untilTimestamp ||
      BigInt(candle.firstSource.blockNumber) < BigInt(value.coverage.fromBlock) ||
      BigInt(candle.lastSource.blockNumber) >= BigInt(value.coverage.untilBlock) ||
      (previous !== undefined && (
        candle.intervalStart <= previous.intervalStart ||
        BigInt(previous.lastSource.blockNumber) >= BigInt(candle.firstSource.blockNumber)
      ))
    ) context.addIssue({ code: "custom", message: "Execution day candle sequence is inconsistent." });
    for (const position of [candle.firstSource, candle.lastSource]) {
      if (recordSwapPositionIdentity(identities, position)) {
        context.addIssue({ code: "custom", message: "Execution candle Swap positions conflict." });
      }
    }
    previous = candle;
  }
});
export type StockTokenExecutionIndexDay = z.infer<typeof stockTokenExecutionIndexDaySchema>;

export interface StockTokenExecutionIndexMonthAdmission {
  readonly reference: StockTokenExecutionMonthReference;
  readonly month: StockTokenExecutionIndexMonth;
  readonly sha256: string;
}
export interface StockTokenExecutionIndexDayAdmission {
  readonly reference: StockTokenExecutionDayReference;
  readonly day: StockTokenExecutionIndexDay;
  readonly sha256: string;
}

export const stockTokenExecutionIndexUnavailableReasonSchema = z.enum([
  "asset_not_indexed",
  "index_unavailable",
  "index_inconsistent",
  "outside_published_coverage",
]);
export type StockTokenExecutionIndexUnavailableReason = z.infer<typeof stockTokenExecutionIndexUnavailableReasonSchema>;
export const stockTokenExecutionCoverageLimitationSchema = z.enum([
  "before_published_coverage",
  "after_published_coverage",
]);
export type StockTokenExecutionCoverageLimitation = z.infer<typeof stockTokenExecutionCoverageLimitationSchema>;
export const stockTokenExecutionDetailLimitationSchema = z.literal("candle_capacity");
export type StockTokenExecutionDetailLimitation = z.infer<
  typeof stockTokenExecutionDetailLimitationSchema
>;

const executionRequestWindowMilliseconds = maximumMarketTimeWindowMilliseconds;
const utcDayMilliseconds = 86_400_000;
const shortestUtcMonthMilliseconds = 28 * utcDayMilliseconds;
export const stockTokenExecutionSeriesLimits = Object.freeze({
  candles: 3_072,
  coverageIntervals: Math.ceil(executionRequestWindowMilliseconds / utcDayMilliseconds) + 1,
  dayArtifacts: Math.ceil(executionRequestWindowMilliseconds / utcDayMilliseconds) + 1,
  displayPositions: stockTokenExecutionDisplayWindowDefinitions["30d"].maximumPositionCount,
  monthArtifacts: Math.ceil(executionRequestWindowMilliseconds / shortestUtcMonthMilliseconds) + 1,
  observedCandles: executionRequestWindowMilliseconds / 60_000,
  requestWindowMilliseconds: executionRequestWindowMilliseconds,
  freshnessMilliseconds: 30 * 60 * 1_000,
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
    pairId: hash32Schema,
    sequence: positiveSafeIntegerSchema,
    coveredUntilTimestamp: minuteTimestampSchema,
    stateSha256: sha256HexSchema,
    months: z.array(jsonObject({ month: canonicalMonthSchema, sha256: sha256HexSchema }).strict())
      .min(1).max(stockTokenExecutionSeriesLimits.monthArtifacts),
    days: z.array(jsonObject({ day: canonicalDaySchema, sha256: sha256HexSchema }).strict())
      .min(1).max(stockTokenExecutionSeriesLimits.dayArtifacts),
  }).strict(),
  freshness: z.enum(["current", "stale"]),
  coverage: jsonObject({
    status: z.enum(["complete", "partial"]),
    intervals: z.array(stockTokenExecutionCoverageIntervalSchema)
      .min(1).max(stockTokenExecutionSeriesLimits.coverageIntervals),
    limitations: z.array(stockTokenExecutionCoverageLimitationSchema)
      .max(stockTokenExecutionCoverageLimitationSchema.options.length),
  }).strict(),
  detail: jsonObject({
    status: z.enum(["complete", "limited"]),
    observedCandleCount: z.number().int().nonnegative().max(stockTokenExecutionSeriesLimits.observedCandles),
    limitations: z.array(stockTokenExecutionDetailLimitationSchema).max(1),
  }).strict(),
  displaySeries: stockTokenExecutionDisplaySeriesSchema,
  candles: z.array(stockTokenExecutionCandleSchema).max(stockTokenExecutionSeriesLimits.candles),
}).strict();
const executionSeriesUnionSchema = z.discriminatedUnion("status", [
  executionSeriesUnavailableSchema,
  executionSeriesAvailableSchema,
]);

const displayCoverageForFrame = (
  intervals: readonly StockTokenExecutionCoverageInterval[],
  representedStart: string,
  representedEnd: string,
): StockTokenExecutionDisplayPositionCoverage => {
  const representedStartTime = Date.parse(representedStart);
  const representedEndTime = Date.parse(representedEnd);
  let cursor = representedStartTime;
  let overlapsCoverage = false;
  let hasGap = false;
  for (const interval of intervals) {
    const overlapStart = Math.max(representedStartTime, Date.parse(interval.fromTimestamp));
    const overlapEnd = Math.min(representedEndTime, Date.parse(interval.untilTimestamp));
    if (overlapStart >= overlapEnd) continue;
    overlapsCoverage = true;
    if (overlapStart > cursor) hasGap = true;
    cursor = Math.max(cursor, overlapEnd);
  }
  if (!overlapsCoverage) return "unavailable";
  const sourceMinuteBoundaries = representedStartTime % 60_000 === 0 &&
    representedEndTime % 60_000 === 0;
  return sourceMinuteBoundaries && !hasGap && cursor >= representedEndTime
    ? "complete" : "partial";
};

export const stockTokenExecutionSeriesSchema = executionSeriesUnionSchema.superRefine((value, context) => {
  if (value.requestedStart >= value.requestedEnd) {
    context.addIssue({ code: "custom", message: "Execution series request interval is invalid." });
  }
  if (
    Date.parse(value.requestedEnd) - Date.parse(value.requestedStart) >
      stockTokenExecutionSeriesLimits.requestWindowMilliseconds
  ) {
    context.addIssue({ code: "custom", message: "Execution series request interval exceeds 30 days." });
  }
  if (value.status !== "available") return;
  const expectedMonths = [...new Set(value.artifact.days.map((entry) => entry.day.slice(0, 7)))];
  if (
    expectedMonths.length !== value.artifact.months.length ||
    expectedMonths.some((month, index) => value.artifact.months[index]?.month !== month)
  ) context.addIssue({ code: "custom", message: "Execution artifact month and day references disagree." });
  const asset = findStockTokenExecutionIndexAssetByPairId(value.source.poolId);
  if (
    asset === undefined || value.artifact.pairId !== value.source.poolId ||
    value.source.chainId !== asset.pair.chainId || value.source.finality !== asset.pair.finality ||
    value.source.poolManager !== asset.pair.poolManager ||
    value.source.quoteToken.address !== asset.pair.quoteAsset.address ||
    value.source.quoteToken.decimals !== asset.pair.quoteAsset.decimals
  ) context.addIssue({ code: "custom", message: "Execution series source differs from its pair." });
  const display = value.displaySeries;
  if (
    display.requestedStart !== value.requestedStart ||
    display.requestedEnd !== value.requestedEnd ||
    display.source.chainId !== value.source.chainId ||
    display.source.finality !== value.source.finality ||
    display.source.poolManager !== value.source.poolManager ||
    display.source.poolId !== value.source.poolId ||
    display.source.quoteToken.address !== value.source.quoteToken.address ||
    display.source.quoteToken.decimals !== value.source.quoteToken.decimals ||
    display.source.quoteToken.symbol !== value.source.quoteToken.symbol ||
    asset === undefined || display.source.token.address !== asset.token ||
    display.source.token.decimals !== asset.tokenDecimals ||
    display.source.token.symbol !== asset.symbol
  ) context.addIssue({ code: "custom", message: "Execution display series differs from its owner." });
  const projectionLengthsMatch = value.artifact.days.length === value.coverage.intervals.length;
  if (
    value.artifact.months.some((entry, index) => index > 0 &&
      entry.month <= value.artifact.months[index - 1]!.month) ||
    value.artifact.days.some((entry, index) => index > 0 &&
      entry.day <= value.artifact.days[index - 1]!.day) ||
    !projectionLengthsMatch
  ) context.addIssue({ code: "custom", message: "Execution series artifact projection is inconsistent." });
  if (!projectionLengthsMatch) return;
  for (let index = 0; index < value.coverage.intervals.length; index += 1) {
    const day = value.artifact.days[index]!;
    const interval = value.coverage.intervals[index]!;
    const dayStart = `${day.day}T00:00:00.000Z`;
    const dayUntil = new Date(Date.parse(dayStart) + utcDayMilliseconds).toISOString();
    if (
      interval.fromTimestamp < dayStart || interval.untilTimestamp > dayUntil ||
      interval.untilTimestamp <= value.requestedStart || interval.fromTimestamp >= value.requestedEnd ||
      interval.untilTimestamp > value.artifact.coveredUntilTimestamp
    ) context.addIssue({ code: "custom", message: "Execution series artifact coverage is inconsistent." });
  }
  for (let index = 1; index < value.coverage.intervals.length; index += 1) {
    const previous = value.coverage.intervals[index - 1]!;
    const current = value.coverage.intervals[index]!;
    if (previous.untilTimestamp !== current.fromTimestamp || previous.untilBlock !== current.fromBlock) {
      context.addIssue({ code: "custom", message: "Execution series coverage is not continuous." });
    }
  }
  const seriesIdentities = createSwapPositionIdentityState();
  const displayCandlePositionIndexes = new Set<number>();
  for (let index = 0; index < display.positions.length; index += 1) {
    const position = display.positions[index]!;
    const expectedCoverage = displayCoverageForFrame(
      value.coverage.intervals,
      position.representedStart,
      position.representedEnd,
    );
    if (
      position.coverage !== expectedCoverage ||
      (expectedCoverage === "unavailable" && position.candle !== null)
    ) context.addIssue({ code: "custom", message: "Execution display coverage is inconsistent." });
    const aggregate = position.candle;
    if (aggregate === null) continue;
    displayCandlePositionIndexes.add(index);
    const covered = value.coverage.intervals.some((interval) =>
      aggregate.observedStart >= interval.fromTimestamp &&
      aggregate.observedEnd <= interval.untilTimestamp &&
      BigInt(aggregate.firstSource.blockNumber) >= BigInt(interval.fromBlock) &&
      BigInt(aggregate.lastSource.blockNumber) < BigInt(interval.untilBlock));
    const firstIdentityConflict = recordSwapPositionIdentity(seriesIdentities, aggregate.firstSource);
    const lastIdentityConflict = recordSwapPositionIdentity(seriesIdentities, aggregate.lastSource);
    if (!covered || firstIdentityConflict || lastIdentityConflict) {
      context.addIssue({ code: "custom", message: "Execution display source is inconsistent." });
    }
  }
  let previousCandle: StockTokenExecutionCandle | undefined;
  const detailedPositionBounds = new Map<number, {
    first: StockTokenExecutionCandle;
    last: StockTokenExecutionCandle;
  }>();
  for (const candle of value.candles) {
    const covered = value.coverage.intervals.some((interval) =>
      candle.intervalStart >= interval.fromTimestamp && candle.intervalEnd <= interval.untilTimestamp &&
      BigInt(candle.firstSource.blockNumber) >= BigInt(interval.fromBlock) &&
      BigInt(candle.lastSource.blockNumber) < BigInt(interval.untilBlock));
    if (
      asset === undefined || candle.symbol !== asset.symbol || candle.token !== asset.token ||
      candle.poolId !== asset.poolId || candle.intervalStart < value.requestedStart ||
      candle.intervalEnd > value.requestedEnd || !covered ||
      (previousCandle !== undefined && (
        candle.intervalStart <= previousCandle.intervalStart ||
        BigInt(previousCandle.lastSource.blockNumber) >= BigInt(candle.firstSource.blockNumber)
      ))
    ) context.addIssue({ code: "custom", message: "Execution series candle membership is invalid." });
    const firstIdentityConflict = recordSwapPositionIdentity(seriesIdentities, candle.firstSource);
    const lastIdentityConflict = recordSwapPositionIdentity(seriesIdentities, candle.lastSource);
    if (firstIdentityConflict || lastIdentityConflict) {
      context.addIssue({ code: "custom", message: "Execution series Swap positions conflict." });
    }
    const positionIndex = display.positions.findIndex((candidate) =>
      candle.intervalStart >= candidate.intervalStart && candle.intervalStart < candidate.intervalEnd);
    const aggregate = positionIndex < 0 ? undefined : display.positions[positionIndex]?.candle;
    if (
      positionIndex < 0 || aggregate === null || aggregate === undefined ||
      candle.intervalStart < aggregate.observedStart || candle.intervalEnd > aggregate.observedEnd ||
      compareSwapPositions(aggregate.firstSource, candle.firstSource) > 0 ||
      compareSwapPositions(aggregate.lastSource, candle.lastSource) < 0
    ) context.addIssue({ code: "custom", message: "Execution detail and display series disagree." });
    else {
      const bounds = detailedPositionBounds.get(positionIndex);
      if (bounds === undefined) detailedPositionBounds.set(positionIndex, { first: candle, last: candle });
      else bounds.last = candle;
    }
    previousCandle = candle;
  }
  const expected = new Set<StockTokenExecutionCoverageLimitation>();
  if (value.coverage.intervals[0]!.fromTimestamp > value.requestedStart) {
    expected.add("before_published_coverage");
  }
  if (value.coverage.intervals.at(-1)!.untilTimestamp < value.requestedEnd) {
    expected.add("after_published_coverage");
  }
  const stale = Date.parse(value.requestedEnd) - Date.parse(value.artifact.coveredUntilTimestamp) >
    stockTokenExecutionSeriesLimits.freshnessMilliseconds;
  const ordered = stockTokenExecutionCoverageLimitationSchema.options.filter((limitation) =>
    expected.has(limitation));
  const detailLimited = value.detail.observedCandleCount > stockTokenExecutionSeriesLimits.candles;
  const displayHasCandle = display.positions.some((position) => position.candle !== null);
  const maximumObservedCandleCount = value.coverage.intervals.reduce((total, interval) => {
    const intersectionStart = Math.max(Date.parse(value.requestedStart), Date.parse(interval.fromTimestamp));
    const intersectionEnd = Math.min(Date.parse(value.requestedEnd), Date.parse(interval.untilTimestamp));
    const firstCompleteMinuteStart = Math.ceil(intersectionStart / 60_000) * 60_000;
    return total + Math.max(0, Math.floor((intersectionEnd - firstCompleteMinuteStart) / 60_000));
  }, 0);
  const firstDetailedPositionIndex = detailedPositionBounds.size === 0
    ? undefined : Math.min(...detailedPositionBounds.keys());
  const returnedSuffixWitnessesDisplay = value.detail.status === "complete"
    ? [...displayCandlePositionIndexes].every((index) => detailedPositionBounds.has(index))
    : firstDetailedPositionIndex !== undefined &&
      [...displayCandlePositionIndexes].every((index) =>
        index < firstDetailedPositionIndex || detailedPositionBounds.has(index));
  const returnedSuffixBoundariesAgree = [...detailedPositionBounds].every(([index, bounds]) => {
    const aggregate = display.positions[index]?.candle;
    if (
      aggregate === null || aggregate === undefined ||
      aggregate.observedEnd !== bounds.last.intervalEnd ||
      !sameSwapPosition(aggregate.lastSource, bounds.last.lastSource)
    ) return false;
    const fullyReturnedPosition = value.detail.status === "complete" ||
      (firstDetailedPositionIndex !== undefined && index > firstDetailedPositionIndex);
    return !fullyReturnedPosition || (
      aggregate.observedStart === bounds.first.intervalStart &&
      sameSwapPosition(aggregate.firstSource, bounds.first.firstSource)
    );
  });
  if (
    value.freshness !== (stale ? "stale" : "current") ||
    value.coverage.limitations.join("\0") !== ordered.join("\0") ||
    value.coverage.status !== (ordered.length === 0 ? "complete" : "partial") ||
    value.detail.status !== (detailLimited ? "limited" : "complete") ||
    value.detail.limitations.join("\0") !== (detailLimited ? "candle_capacity" : "") ||
    displayHasCandle !== (value.detail.observedCandleCount > 0) ||
    value.detail.observedCandleCount > maximumObservedCandleCount ||
    displayCandlePositionIndexes.size > value.detail.observedCandleCount ||
    !returnedSuffixWitnessesDisplay ||
    !returnedSuffixBoundariesAgree ||
    (value.detail.observedCandleCount <= stockTokenExecutionSeriesLimits.candles
      ? value.detail.observedCandleCount !== value.candles.length
      : value.candles.length !== stockTokenExecutionSeriesLimits.candles)
  ) context.addIssue({ code: "custom", message: "Execution series derived state is inconsistent." });
});
export type StockTokenExecutionSeries = z.infer<typeof stockTokenExecutionSeriesSchema>;

export interface StockTokenExecutionIndexReadInput {
  readonly pairId: string;
  readonly window: MarketTimeWindow;
  readonly requestedStart: string;
  readonly requestedEnd: string;
}
export interface StockTokenExecutionIndexReadPort {
  read(input: StockTokenExecutionIndexReadInput, signal?: AbortSignal): Promise<StockTokenExecutionSeries>;
}

const exactReference = (
  references: readonly StockTokenExecutionArtifactReference[],
  candidate: StockTokenExecutionArtifactReference,
): StockTokenExecutionArtifactReference | undefined => references.find((reference) =>
  canonicalEqual(reference, candidate));
const overlaps = (coverage: StockTokenExecutionCoverageInterval, from: string, until: string): boolean =>
  coverage.untilTimestamp > from && coverage.fromTimestamp < until;
const limitationOrder = stockTokenExecutionCoverageLimitationSchema.options;

interface ExecutionDisplayAggregateState {
  readonly open: z.infer<typeof exactRationalSchema>;
  high: z.infer<typeof exactRationalSchema>;
  low: z.infer<typeof exactRationalSchema>;
  close: z.infer<typeof exactRationalSchema>;
  readonly firstSource: StockTokenExecutionSwapPosition;
  lastSource: StockTokenExecutionSwapPosition;
  readonly observedStart: string;
  observedEnd: string;
  quoteVolumeRaw: bigint;
  sourceCandleCount: number;
  tokenVolumeRaw: bigint;
  tradeCount: bigint;
}

const createExecutionDisplaySeries = (input: Readonly<{
  request: StockTokenExecutionIndexReadInput;
  asset: StockTokenExecutionIndexAsset;
  intervals: readonly StockTokenExecutionCoverageInterval[];
  candles: readonly StockTokenExecutionCandle[];
}>): StockTokenExecutionDisplaySeries => {
  const frames = executionDisplayPositionFrames(
    input.request.window,
    input.request.requestedStart,
    input.request.requestedEnd,
  );
  const definition = stockTokenExecutionDisplayWindowDefinitions[input.request.window];
  if (frames.length > definition.maximumPositionCount || frames.length === 0) {
    throw new TypeError("Execution display position count exceeds its window bound.");
  }
  const firstIntervalStart = Date.parse(frames[0]!.intervalStart);
  const aggregates = new Array<ExecutionDisplayAggregateState | undefined>(frames.length);
  for (const candle of input.candles) {
    const candleStart = Date.parse(candle.intervalStart);
    const index = Math.floor(
      (candleStart - firstIntervalStart) / definition.intervalMilliseconds,
    );
    const frame = frames[index];
    if (
      frame === undefined || candle.intervalStart < frame.intervalStart ||
      candle.intervalEnd > frame.intervalEnd
    ) throw new TypeError("Execution candle does not belong to one display position.");
    const aggregate = aggregates[index];
    if (aggregate === undefined) {
      aggregates[index] = {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        tokenVolumeRaw: BigInt(candle.tokenVolumeRaw),
        quoteVolumeRaw: BigInt(candle.quoteVolumeRaw),
        tradeCount: BigInt(candle.tradeCount),
        firstSource: candle.firstSource,
        lastSource: candle.lastSource,
        observedStart: candle.intervalStart,
        observedEnd: candle.intervalEnd,
        sourceCandleCount: 1,
      };
      continue;
    }
    if (
      candle.intervalStart <= aggregate.observedStart ||
      compareSwapPositions(aggregate.lastSource, candle.firstSource) >= 0
    ) throw new TypeError("Execution display source candle sequence is invalid.");
    if (compareExactRationals(candle.high, aggregate.high) > 0) aggregate.high = candle.high;
    if (compareExactRationals(candle.low, aggregate.low) < 0) aggregate.low = candle.low;
    aggregate.close = candle.close;
    aggregate.tokenVolumeRaw += BigInt(candle.tokenVolumeRaw);
    aggregate.quoteVolumeRaw += BigInt(candle.quoteVolumeRaw);
    aggregate.tradeCount += BigInt(candle.tradeCount);
    aggregate.lastSource = candle.lastSource;
    aggregate.observedEnd = candle.intervalEnd;
    aggregate.sourceCandleCount += 1;
  }
  const maximumSourceCandles = definition.intervalMilliseconds / 60_000;
  const positions = frames.map((frame, index) => {
    const aggregate = aggregates[index];
    if (aggregate !== undefined && aggregate.sourceCandleCount > maximumSourceCandles) {
      throw new TypeError("Execution display position contains too many source candles.");
    }
    return {
      ...frame,
      coverage: displayCoverageForFrame(
        input.intervals,
        frame.representedStart,
        frame.representedEnd,
      ),
      candle: aggregate === undefined ? null : {
        open: aggregate.open,
        high: aggregate.high,
        low: aggregate.low,
        close: aggregate.close,
        tokenVolumeRaw: aggregate.tokenVolumeRaw.toString(),
        quoteVolumeRaw: aggregate.quoteVolumeRaw.toString(),
        tradeCount: aggregate.tradeCount.toString(),
        firstSource: aggregate.firstSource,
        lastSource: aggregate.lastSource,
        observedStart: aggregate.observedStart,
        observedEnd: aggregate.observedEnd,
      },
    };
  });
  const quote = input.asset.pair.quoteAsset;
  return deepFreezeValue(stockTokenExecutionDisplaySeriesSchema.parse({
    window: input.request.window,
    requestedStart: input.request.requestedStart,
    requestedEnd: input.request.requestedEnd,
    source: {
      chainId: input.asset.pair.chainId,
      finality: input.asset.pair.finality,
      poolManager: input.asset.pair.poolManager,
      poolId: input.asset.poolId,
      token: {
        address: input.asset.token,
        decimals: input.asset.tokenDecimals,
        symbol: input.asset.symbol,
      },
      quoteToken: { address: quote.address, decimals: quote.decimals, symbol: "USDG" },
    },
    positions,
  }));
};

export const createStockTokenExecutionSeries = (input: Readonly<{
  request: StockTokenExecutionIndexReadInput;
  asset: StockTokenExecutionIndexAsset;
  state: StockTokenExecutionIndexState;
  stateSha256: string;
  months: readonly StockTokenExecutionIndexMonthAdmission[];
  days: readonly StockTokenExecutionIndexDayAdmission[];
}>): StockTokenExecutionSeries => {
  const asset = executionIndexAssetSchema.parse(input.asset);
  const registeredAsset = findStockTokenExecutionIndexAssetByPairId(asset.poolId);
  if (registeredAsset === undefined || !canonicalEqual(registeredAsset, asset)) {
    throw new TypeError("Execution-index asset differs from the admitted registry.");
  }
  const request = {
    pairId: hash32Schema.parse(input.request.pairId),
    window: marketTimeWindowSchema.parse(input.request.window),
    requestedStart: utcTimestampSchema.parse(input.request.requestedStart),
    requestedEnd: utcTimestampSchema.parse(input.request.requestedEnd),
  };
  if (
    request.pairId !== asset.poolId || request.requestedStart >= request.requestedEnd ||
    Date.parse(request.requestedEnd) - Date.parse(request.requestedStart) !==
      marketTimeWindowDefinitions[request.window].durationMilliseconds
  ) {
    throw new TypeError("Execution-index request identity or interval is invalid.");
  }
  const state = stockTokenExecutionIndexStateSchema.parse(input.state);
  const stateSha256 = sha256HexSchema.parse(input.stateSha256);
  if (
    state.pair.pairId !== asset.poolId || !canonicalEqual(state.pair, asset.pair) ||
    sha256Bytes(new TextEncoder().encode(canonicalStockTokenExecutionIndexJson(state))) !== stateSha256
  ) throw new TypeError("Execution-index selected state is inconsistent.");

  const stateIntersectionFrom = request.requestedStart > state.coverage.fromTimestamp
    ? request.requestedStart : state.coverage.fromTimestamp;
  const stateIntersectionUntil = request.requestedEnd < state.coverage.untilTimestamp
    ? request.requestedEnd : state.coverage.untilTimestamp;
  if (stateIntersectionFrom >= stateIntersectionUntil) {
    if (input.months.length !== 0 || input.days.length !== 0) {
      throw new TypeError("Execution-index read retained artifacts outside selected coverage.");
    }
    return unavailableStockTokenExecutionSeries(request, "outside_published_coverage");
  }

  const requiredMonthReferences = state.months.filter((reference) =>
    overlaps(reference.coverage, stateIntersectionFrom, stateIntersectionUntil));
  const months = input.months.map((entry) => ({
    reference: stockTokenExecutionArtifactReferenceSchema.parse(entry.reference),
    month: stockTokenExecutionIndexMonthSchema.parse(entry.month),
    sha256: sha256HexSchema.parse(entry.sha256),
  })).sort((left, right) => compareCodePointSequences(left.month.month, right.month.month));
  if (months.length !== requiredMonthReferences.length) {
    throw new TypeError("Execution-index pair-month files do not cover the selected pair state.");
  }
  for (const entry of months) {
    if (
      exactReference(requiredMonthReferences, entry.reference) === undefined ||
      entry.month.pair.pairId !== asset.poolId ||
      entry.reference.logicalId !== stockTokenExecutionPairMonthLogicalId(asset.poolId, entry.month.month) ||
      entry.reference.sequence !== entry.month.sequence ||
      !canonicalEqual(entry.reference.coverage, entry.month.coverage) ||
      entry.reference.jsonSha256 !== entry.sha256 ||
      sha256Bytes(new TextEncoder().encode(canonicalStockTokenExecutionIndexJson(entry.month))) !== entry.sha256
    ) throw new TypeError("Execution-index state and month admissions are not correlated.");
  }

  const requiredDayReferences = months.flatMap((entry) => entry.month.days)
    .filter((reference) => overlaps(reference.coverage, stateIntersectionFrom, stateIntersectionUntil));
  const days = input.days.map((entry) => ({
    reference: stockTokenExecutionArtifactReferenceSchema.parse(entry.reference),
    day: stockTokenExecutionIndexDaySchema.parse(entry.day),
    sha256: sha256HexSchema.parse(entry.sha256),
  })).sort((left, right) => compareCodePointSequences(left.day.day, right.day.day));
  if (days.length !== requiredDayReferences.length) {
    throw new TypeError("Execution-index pair-day files do not cover the selected pair months.");
  }
  for (const entry of days) {
    if (
      exactReference(requiredDayReferences, entry.reference) === undefined ||
      entry.day.pair.pairId !== asset.poolId ||
      entry.reference.logicalId !== stockTokenExecutionPairDayLogicalId(asset.poolId, entry.day.day) ||
      entry.reference.sequence !== entry.day.sequence ||
      !canonicalEqual(entry.reference.coverage, entry.day.coverage) ||
      entry.reference.jsonSha256 !== entry.sha256 ||
      sha256Bytes(new TextEncoder().encode(canonicalStockTokenExecutionIndexJson(entry.day))) !== entry.sha256
    ) throw new TypeError("Execution-index month and day admissions are not correlated.");
  }

  const intervals = days.map((entry) => entry.day.coverage);
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1]!;
    const current = intervals[index]!;
    if (
      previous.untilTimestamp !== current.fromTimestamp || previous.untilBlock !== current.fromBlock
    ) throw new TypeError("Execution-index merged coverage is not continuous.");
  }
  let previousArtifactCandle: StockTokenExecutionArtifactCandle | undefined;
  const artifactCandles = days.flatMap((entry) => entry.day.candles);
  const artifactIdentities = createSwapPositionIdentityState();
  for (const candle of artifactCandles) {
    if (previousArtifactCandle !== undefined && (
      candle.intervalStart <= previousArtifactCandle.intervalStart ||
      BigInt(previousArtifactCandle.lastSource.blockNumber) >= BigInt(candle.firstSource.blockNumber)
    )) throw new TypeError("Execution-index merged candle sequence is inconsistent.");
    const firstIdentityConflict = recordSwapPositionIdentity(artifactIdentities, candle.firstSource);
    const lastIdentityConflict = recordSwapPositionIdentity(artifactIdentities, candle.lastSource);
    if (firstIdentityConflict || lastIdentityConflict) {
      throw new TypeError("Execution-index merged candle Swap positions conflict.");
    }
    previousArtifactCandle = candle;
  }
  const allCandles = artifactCandles
    .filter((candle) => candle.intervalStart >= request.requestedStart && candle.intervalEnd <= request.requestedEnd)
    .map((candle) => {
      const { baseVolumeRaw, ...rest } = candle;
      return stockTokenExecutionCandleSchema.parse({
        ...rest,
        symbol: asset.symbol,
        token: asset.token,
        poolId: asset.poolId,
        tokenVolumeRaw: baseVolumeRaw,
      });
    });
  const displaySeries = createExecutionDisplaySeries({
    request,
    asset,
    intervals,
    candles: allCandles,
  });
  const capacityLimited = allCandles.length > stockTokenExecutionSeriesLimits.candles;
  const candles = capacityLimited ? allCandles.slice(-stockTokenExecutionSeriesLimits.candles) : allCandles;
  const stale = Date.parse(request.requestedEnd) - Date.parse(state.coverage.untilTimestamp) >
    stockTokenExecutionSeriesLimits.freshnessMilliseconds;
  const limitations = new Set<StockTokenExecutionCoverageLimitation>();
  if (stateIntersectionFrom > request.requestedStart) limitations.add("before_published_coverage");
  if (stateIntersectionUntil < request.requestedEnd) limitations.add("after_published_coverage");
  const orderedLimitations = limitationOrder.filter((limitation) => limitations.has(limitation));
  const quote = asset.pair.quoteAsset;
  return deepFreezeValue(stockTokenExecutionSeriesSchema.parse({
    status: "available",
    requestedStart: request.requestedStart,
    requestedEnd: request.requestedEnd,
    source: {
      chainId: asset.pair.chainId,
      finality: asset.pair.finality,
      poolManager: asset.pair.poolManager,
      poolId: asset.poolId,
      quoteToken: { address: quote.address, decimals: quote.decimals, symbol: "USDG" },
    },
    artifact: {
      contractVersion: state.contractVersion,
      pairId: asset.poolId,
      sequence: state.sequence,
      coveredUntilTimestamp: state.coverage.untilTimestamp,
      stateSha256,
      months: months.map((entry) => ({ month: entry.month.month, sha256: entry.sha256 })),
      days: days.map((entry) => ({ day: entry.day.day, sha256: entry.sha256 })),
    },
    freshness: stale ? "stale" : "current",
    coverage: {
      status: orderedLimitations.length === 0 ? "complete" : "partial",
      intervals,
      limitations: orderedLimitations,
    },
    detail: {
      status: capacityLimited ? "limited" : "complete",
      observedCandleCount: allCandles.length,
      limitations: capacityLimited ? ["candle_capacity"] : [],
    },
    displaySeries,
    candles,
  }));
};

export const unavailableStockTokenExecutionSeries = (
  input: Pick<StockTokenExecutionIndexReadInput, "requestedStart" | "requestedEnd">,
  reason: StockTokenExecutionIndexUnavailableReason,
): StockTokenExecutionSeries => deepFreezeValue(stockTokenExecutionSeriesSchema.parse({
  status: "unavailable",
  reason,
  requestedStart: input.requestedStart,
  requestedEnd: input.requestedEnd,
}));
