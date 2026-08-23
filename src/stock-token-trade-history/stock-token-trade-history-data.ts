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
  productUsdgAsset,
  sha256Bytes,
  unsignedDecimalSchema,
  utcTimestampSchema,
  type EvmAddress,
  type MarketTimeWindow,
} from "../core/client.js";
import {
  stockTokenTradeHistoryRegistryJson,
  stockTokenTradeHistoryRegistrySourceSha256,
} from "./stock-token-trade-history-registry.generated.js";

export const stockTokenTradeHistoryRegistrySha256 =
  stockTokenTradeHistoryRegistrySourceSha256;

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

export const stockTokenTradeHistoryChartWindowDefinitions = deepFreezeValue({
  "1d": { intervalMilliseconds: 15 * 60_000, fullPositionCount: 96, maximumPositionCount: 97 },
  "7d": { intervalMilliseconds: 60 * 60_000, fullPositionCount: 168, maximumPositionCount: 169 },
  "30d": { intervalMilliseconds: 4 * 60 * 60_000, fullPositionCount: 180, maximumPositionCount: 181 },
} satisfies Readonly<Record<MarketTimeWindow, Readonly<{
  intervalMilliseconds: number;
  fullPositionCount: number;
  maximumPositionCount: number;
}>>>);

const maximumSourceCandlesPerChartPosition = 240n;
const maximumSourceCandleInteger = 10n ** 78n - 1n;
const maximumChartVolumeRaw = maximumSourceCandlesPerChartPosition * maximumSourceCandleInteger;
const maximumChartTradeCount = maximumSourceCandlesPerChartPosition * BigInt(Number.MAX_SAFE_INTEGER);
const unsignedDecimalAtMost = (value: string, maximum: bigint): boolean => {
  const maximumText = maximum.toString();
  return value.length < maximumText.length ||
    (value.length === maximumText.length && value <= maximumText);
};
const chartVolumeRawSchema = unsignedDecimalSchema.refine(
  (value) => value !== "0" && unsignedDecimalAtMost(value, maximumChartVolumeRaw),
  "Chart aggregate volume exceeds its source-derived maximum.",
);
const chartTradeCountSchema = unsignedDecimalSchema.refine(
  (value) => value !== "0" && unsignedDecimalAtMost(value, maximumChartTradeCount),
  "Chart aggregate trade count exceeds its source-derived maximum.",
);

export const serializeStockTokenTradeHistoryFileJson = (value: unknown, depth = 0): string => {
  if (depth > 32) throw new TypeError("Trade-history file nesting is excessive.");
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new TypeError("Trade-history file number is not a safe integer.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!isWellFormedText(value)) throw new TypeError("Trade-history file text is invalid.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((member) => serializeStockTokenTradeHistoryFileJson(member, depth + 1)).join(",")}]`;
  }
  if (typeof value !== "object") throw new TypeError("Trade-history file value is invalid.");
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort(compareCodePointSequences);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeStockTokenTradeHistoryFileJson(object[key], depth + 1)}`).join(",")}}`;
};

const sameSerializedTradeHistoryValue = (left: unknown, right: unknown): boolean =>
  serializeStockTokenTradeHistoryFileJson(left) === serializeStockTokenTradeHistoryFileJson(right);

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
const usdgAssetSchema = erc20AssetSchema.extend({
  address: z.literal(productUsdgAsset.address),
}).strict();
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
  baseAsset: erc20AssetSchema,
  baseIsCurrency0: z.boolean(),
  chainId: z.literal(productChainId),
  finality: z.literal("finalized"),
  historyStart: minuteBoundarySchema,
  pairId: hash32Schema,
  poolKey: poolKeySchema,
  poolManager: evmAddressSchema,
  quoteAsset: usdgAssetSchema,
  sourceInitialization: sourceInitializationSchema,
  swapTopic: hash32Schema,
}).strict();
export type StockTokenTradePair = z.infer<typeof pairDescriptorSchema>;

const pairDisplaySchema = jsonObject({
  baseName: z.string().min(1).max(128),
  baseSymbol: z.string().min(1).max(16).regex(/^[A-Z][A-Z0-9.]*$/u),
  label: z.string().min(1).max(64),
  quoteName: z.string().min(1).max(128),
  quoteSymbol: z.literal("USDG"),
}).strict();
const pairEntrySchema = jsonObject({ display: pairDisplaySchema, pair: pairDescriptorSchema }).strict();
const collectionSchema = jsonObject({
  historyMonths: z.literal(12),
  maximumFileBytes: positiveSafeIntegerSchema.max(16_777_216),
}).strict();
const registrySchema = jsonObject({
  chain: jsonObject({
    chainId: z.literal(productChainId),
    finalityTag: z.literal("finalized"),
  }).strict(),
  collection: collectionSchema,
  deployment: jsonObject({
    poolManager: evmAddressSchema,
    swapTopic: hash32Schema,
  }).strict(),
  pairs: z.array(pairEntrySchema).length(8),
}).strict().superRefine((registry, context) => {
  const pairIds = new Set<string>();
  const currencies = new Map<string, string>();
  let previousPairId = "";
  for (const { display, pair } of registry.pairs) {
    const baseCurrency = pair.baseAsset.address;
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
      context.addIssue({ code: "custom", message: "Trade-history pair registry is inconsistent." });
    }
    const baseFacts = `${pair.baseAsset.decimals}:${display.baseSymbol}:${display.baseName}`;
    const quoteFacts = `${pair.quoteAsset.decimals}:${display.quoteSymbol}:${display.quoteName}`;
    if (
      (currencies.has(baseCurrency) && currencies.get(baseCurrency) !== baseFacts) ||
      (currencies.has(pair.quoteAsset.address) && currencies.get(pair.quoteAsset.address) !== quoteFacts)
    ) context.addIssue({ code: "custom", message: "Trade-history asset facts conflict." });
    currencies.set(baseCurrency, baseFacts);
    currencies.set(pair.quoteAsset.address, quoteFacts);
    pairIds.add(pair.pairId);
    previousPairId = pair.pairId;
  }
});

export const stockTokenTradeHistoryRegistry = deepFreezeValue(
  registrySchema.parse(JSON.parse(stockTokenTradeHistoryRegistryJson) as unknown),
);
export const stockTokenTradeHistoryFileMaximumBytes =
  stockTokenTradeHistoryRegistry.collection.maximumFileBytes;

const tradeHistoryQuoteTokenSchema = jsonObject({
  address: evmAddressSchema,
  decimals: z.number().int().nonnegative().max(255),
  symbol: z.literal("USDG"),
}).strict();
const tradeHistoryAssetSchema = jsonObject({
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
export type StockTokenTradeHistoryAsset = z.infer<typeof tradeHistoryAssetSchema>;

const supportedAssets = stockTokenTradeHistoryRegistry.pairs
  .map((entry) => {
    return tradeHistoryAssetSchema.parse({
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
const tradeHistoryAssetByToken = new Map<EvmAddress, StockTokenTradeHistoryAsset>(
  supportedAssets.map((asset) => [asset.token, asset]),
);
const tradeHistoryAssetByPairId = new Map<string, StockTokenTradeHistoryAsset>(
  supportedAssets.map((asset) => [asset.poolId, asset]),
);

export const findStockTokenTradeHistoryAsset = (
  token: EvmAddress,
): StockTokenTradeHistoryAsset | undefined => tradeHistoryAssetByToken.get(token);
export const findStockTokenTradeHistoryAssetByPairId = (
  pairId: string,
): StockTokenTradeHistoryAsset | undefined => tradeHistoryAssetByPairId.get(pairId);

export const stockTokenTradeSwapPositionSchema = jsonObject({
  blockNumber: boundedUnsignedDecimalSchema,
  blockHash: hash32Schema,
  transactionIndex: z.number().int().nonnegative().safe(),
  transactionHash: hash32Schema,
  logIndex: z.number().int().nonnegative().safe(),
}).strict();
export type StockTokenTradeSwapPosition = z.infer<typeof stockTokenTradeSwapPositionSchema>;

const compareSwapPositions = (
  left: StockTokenTradeSwapPosition,
  right: StockTokenTradeSwapPosition,
): number => {
  const block = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (block !== 0n) return block < 0n ? -1 : 1;
  if (left.transactionIndex !== right.transactionIndex) return left.transactionIndex - right.transactionIndex;
  return left.logIndex - right.logIndex;
};
const sameSwapPosition = (
  left: StockTokenTradeSwapPosition,
  right: StockTokenTradeSwapPosition,
): boolean => sameSerializedTradeHistoryValue(left, right);

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
  position: StockTokenTradeSwapPosition,
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
  firstSource: stockTokenTradeSwapPositionSchema,
  lastSource: stockTokenTradeSwapPositionSchema,
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
  first: StockTokenTradeSwapPosition,
  last: StockTokenTradeSwapPosition,
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
    readonly firstSource: StockTokenTradeSwapPosition;
    readonly lastSource: StockTokenTradeSwapPosition;
  },
  context: z.RefinementCtx,
): void => {
  if (
    Date.parse(value.intervalEnd) - Date.parse(value.intervalStart) !== 60_000 ||
    invalidExactOhlc(value) ||
    invalidSwapBoundaryRange(value.firstSource, value.lastSource, value.tradeCount === 1)
  ) context.addIssue({ code: "custom", message: "Trade candle semantics are invalid." });
};

const fileCandleObjectSchema = jsonObject({
  ...candleCoreShape,
  baseVolumeRaw: boundedUnsignedDecimalSchema.refine((value) => value !== "0"),
}).strict();
export const stockTokenTradeHistoryFileCandleSchema = fileCandleObjectSchema.superRefine(validateCandle);
export type StockTokenTradeHistoryFileCandle = z.infer<typeof stockTokenTradeHistoryFileCandleSchema>;

const normalizedCandleObjectSchema = jsonObject({
  symbol: tradeHistoryAssetSchema.shape.symbol,
  token: evmAddressSchema,
  poolId: hash32Schema,
  ...candleCoreShape,
  tokenVolumeRaw: boundedUnsignedDecimalSchema.refine((value) => value !== "0"),
}).strict();
const stockTokenTradeCandleSchema = normalizedCandleObjectSchema.superRefine(validateCandle);
type StockTokenTradeCandle = z.infer<typeof stockTokenTradeCandleSchema>;

export const stockTokenTradeCoverageIntervalSchema = jsonObject({
  fromBlock: boundedUnsignedDecimalSchema,
  fromTimestamp: minuteTimestampSchema,
  untilBlock: boundedUnsignedDecimalSchema,
  untilTimestamp: minuteTimestampSchema,
}).strict().superRefine((value, context) => {
  if (
    BigInt(value.fromBlock) > BigInt(value.untilBlock) ||
    Date.parse(value.fromTimestamp) >= Date.parse(value.untilTimestamp)
  ) context.addIssue({ code: "custom", message: "Trade-history coverage interval is invalid." });
});
export type StockTokenTradeCoverageInterval = z.infer<typeof stockTokenTradeCoverageIntervalSchema>;

const tradeHistoryChartSourceSchema = jsonObject({
  chainId: z.literal(productChainId),
  finality: z.literal("finalized"),
  poolManager: evmAddressSchema,
  poolId: hash32Schema,
  token: jsonObject({
    address: evmAddressSchema,
    decimals: z.number().int().nonnegative().max(255),
    symbol: tradeHistoryAssetSchema.shape.symbol,
  }).strict(),
  quoteToken: tradeHistoryQuoteTokenSchema,
}).strict();

const tradeHistoryChartCandleObjectSchema = jsonObject({
  open: exactRationalSchema,
  high: exactRationalSchema,
  low: exactRationalSchema,
  close: exactRationalSchema,
  tokenVolumeRaw: chartVolumeRawSchema,
  quoteVolumeRaw: chartVolumeRawSchema,
  tradeCount: chartTradeCountSchema,
  firstSource: stockTokenTradeSwapPositionSchema,
  lastSource: stockTokenTradeSwapPositionSchema,
  observedStart: minuteTimestampSchema,
  observedEnd: minuteTimestampSchema,
}).strict();
export const stockTokenTradeHistoryChartCandleSchema = tradeHistoryChartCandleObjectSchema.superRefine(
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
    ) context.addIssue({ code: "custom", message: "Trade-history chart candle semantics are invalid." });
  },
);
export type StockTokenTradeHistoryChartCandle = z.infer<
  typeof stockTokenTradeHistoryChartCandleSchema
>;

export const stockTokenTradeHistoryChartPositionCoverageSchema = z.enum([
  "complete",
  "partial",
  "unavailable",
]);
export type StockTokenTradeHistoryChartPositionCoverage = z.infer<
  typeof stockTokenTradeHistoryChartPositionCoverageSchema
>;

const tradeHistoryChartPositionSchema = jsonObject({
  intervalStart: minuteTimestampSchema,
  intervalEnd: minuteTimestampSchema,
  representedStart: utcTimestampSchema,
  representedEnd: utcTimestampSchema,
  coverage: stockTokenTradeHistoryChartPositionCoverageSchema,
  candle: stockTokenTradeHistoryChartCandleSchema.nullable(),
}).strict();
export type StockTokenTradeHistoryChartPosition = z.infer<typeof tradeHistoryChartPositionSchema>;

interface TradeHistoryChartPositionFrame {
  readonly intervalStart: string;
  readonly intervalEnd: string;
  readonly representedStart: string;
  readonly representedEnd: string;
}

const tradeHistoryChartPositionFrames = (
  window: MarketTimeWindow,
  requestedStart: string,
  requestedEnd: string,
): readonly TradeHistoryChartPositionFrame[] => {
  const definition = stockTokenTradeHistoryChartWindowDefinitions[window];
  const requestedStartTime = Date.parse(requestedStart);
  const requestedEndTime = Date.parse(requestedEnd);
  let intervalStart = Math.floor(requestedStartTime / definition.intervalMilliseconds) *
    definition.intervalMilliseconds;
  const frames: TradeHistoryChartPositionFrame[] = [];
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

const tradeHistoryChartObjectSchema = jsonObject({
  window: marketTimeWindowSchema,
  requestedStart: utcTimestampSchema,
  requestedEnd: utcTimestampSchema,
  source: tradeHistoryChartSourceSchema,
  positions: z.array(tradeHistoryChartPositionSchema)
    .min(stockTokenTradeHistoryChartWindowDefinitions["1d"].fullPositionCount)
    .max(stockTokenTradeHistoryChartWindowDefinitions["30d"].maximumPositionCount),
}).strict();
export const stockTokenTradeHistoryChartSchema = tradeHistoryChartObjectSchema.superRefine(
  (value, context) => {
    const definition = stockTokenTradeHistoryChartWindowDefinitions[value.window];
    if (
      Date.parse(value.requestedEnd) - Date.parse(value.requestedStart) !==
        marketTimeWindowDefinitions[value.window].durationMilliseconds
    ) {
      context.addIssue({ code: "custom", message: "Trade-history chart request does not match its window." });
      return;
    }
    const asset = findStockTokenTradeHistoryAssetByPairId(value.source.poolId);
    if (
      asset === undefined || value.source.chainId !== asset.pair.chainId ||
      value.source.finality !== asset.pair.finality ||
      value.source.poolManager !== asset.pair.poolManager ||
      value.source.token.address !== asset.token ||
      value.source.token.decimals !== asset.tokenDecimals ||
      value.source.token.symbol !== asset.symbol ||
      value.source.quoteToken.address !== asset.pair.quoteAsset.address ||
      value.source.quoteToken.decimals !== asset.pair.quoteAsset.decimals
    ) context.addIssue({ code: "custom", message: "Trade-history chart source differs from its pair." });
    const expected = tradeHistoryChartPositionFrames(
      value.window,
      value.requestedStart,
      value.requestedEnd,
    );
    if (
      expected.length > definition.maximumPositionCount ||
      value.positions.length !== expected.length
    ) {
      context.addIssue({ code: "custom", message: "Trade-history chart position count is invalid." });
      return;
    }
    let previousCandle: StockTokenTradeHistoryChartCandle | undefined;
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
      ) context.addIssue({ code: "custom", message: "Trade-history chart position is inconsistent." });
      const candle = position.candle;
      if (candle === null) continue;
      if (
        candle.observedStart < position.representedStart ||
        candle.observedEnd > position.representedEnd ||
        (previousCandle !== undefined && (
          candle.observedStart <= previousCandle.observedStart ||
          compareSwapPositions(previousCandle.lastSource, candle.firstSource) >= 0
        ))
      ) context.addIssue({ code: "custom", message: "Trade-history chart candle membership is invalid." });
      for (const source of [candle.firstSource, candle.lastSource]) {
        if (recordSwapPositionIdentity(identities, source)) {
          context.addIssue({ code: "custom", message: "Trade-history chart Swap positions conflict." });
        }
      }
      previousCandle = candle;
    }
  },
);
export type StockTokenTradeHistoryChart = z.infer<
  typeof stockTokenTradeHistoryChartSchema
>;

export const stockTokenTradeHistoryFileReferenceSchema = jsonObject({
  coverage: stockTokenTradeCoverageIntervalSchema,
  gzipBytes: positiveSafeIntegerSchema.max(stockTokenTradeHistoryFileMaximumBytes),
  gzipSha256: sha256HexSchema,
  jsonBytes: positiveSafeIntegerSchema.max(stockTokenTradeHistoryFileMaximumBytes),
  jsonSha256: sha256HexSchema,
  logicalId: z.string().min(1).max(256),
  sequence: positiveSafeIntegerSchema,
}).strict().superRefine((reference, context) => {
  const match = reference.logicalId.match(/^pairs\/(0x[0-9a-f]{64})\/(months|days)\/(.+)$/u);
  if (match === null) {
    context.addIssue({ code: "custom", message: "Trade-history file logical identity is invalid." });
    return;
  }
  const [, , kind, period] = match;
  const start = kind === "months" ? `${period}-01T00:00:00.000Z` : `${period}T00:00:00.000Z`;
  const startTime = Date.parse(start);
  if (
    !Number.isFinite(startTime) ||
    (kind === "months" ? !/^\d{4}-\d{2}$/u.test(period!) : !/^\d{4}-\d{2}-\d{2}$/u.test(period!))
  ) {
    context.addIssue({ code: "custom", message: "Trade-history file period is invalid." });
    return;
  }
  const until = new Date(startTime);
  if (kind === "months") until.setUTCMonth(until.getUTCMonth() + 1);
  else until.setUTCDate(until.getUTCDate() + 1);
  if (reference.coverage.fromTimestamp < start || reference.coverage.untilTimestamp > until.toISOString()) {
    context.addIssue({ code: "custom", message: "Trade-history file coverage escapes its period." });
  }
});
export type StockTokenTradeHistoryFileReference = z.infer<typeof stockTokenTradeHistoryFileReferenceSchema>;
export type StockTokenTradeMonthReference = StockTokenTradeHistoryFileReference;
export type StockTokenTradeDayReference = StockTokenTradeHistoryFileReference;

export const stockTokenTradePairStateLogicalId = (pairId: string): string => `pairs/${pairId}/state`;
export const stockTokenTradePairMonthLogicalId = (pairId: string, month: string): string =>
  `pairs/${pairId}/months/${month}`;
export const stockTokenTradePairDayLogicalId = (pairId: string, day: string): string =>
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
  references: readonly StockTokenTradeHistoryFileReference[],
  expectedLogicalIds: readonly string[],
  ownerSequence: number,
  ownerCoverage: StockTokenTradeCoverageInterval,
  context: z.RefinementCtx,
): void => {
  if (references.length !== expectedLogicalIds.length) {
    context.addIssue({ code: "custom", message: "Trade-history file references do not cover their owner." });
    return;
  }
  let block = ownerCoverage.fromBlock;
  let timestamp = ownerCoverage.fromTimestamp;
  let includesOwnerGeneration = false;
  references.forEach((reference, index) => {
    if (
      reference.logicalId !== expectedLogicalIds[index] || reference.sequence > ownerSequence ||
      reference.coverage.fromBlock !== block || reference.coverage.fromTimestamp !== timestamp
    ) context.addIssue({ code: "custom", message: "Trade-history file reference order or coverage is inconsistent." });
    if (reference.sequence === ownerSequence) includesOwnerGeneration = true;
    block = reference.coverage.untilBlock;
    timestamp = reference.coverage.untilTimestamp;
  });
  if (
    block !== ownerCoverage.untilBlock || timestamp !== ownerCoverage.untilTimestamp || !includesOwnerGeneration
  ) context.addIssue({ code: "custom", message: "Trade-history file references do not close their owner generation." });
};

const pairStateObjectSchema = jsonObject({
  contractVersion: z.literal("1"),
  coverage: stockTokenTradeCoverageIntervalSchema,
  kind: z.literal("pair_candle_state"),
  months: z.array(stockTokenTradeHistoryFileReferenceSchema).min(1),
  pair: pairDescriptorSchema,
  sequence: positiveSafeIntegerSchema,
}).strict();
export const stockTokenTradeHistoryStateSchema = pairStateObjectSchema.superRefine((value, context) => {
  const entry = stockTokenTradeHistoryRegistry.pairs.find((candidate) => candidate.pair.pairId === value.pair.pairId);
  if (
    entry === undefined || !sameSerializedTradeHistoryValue(entry.pair, value.pair) ||
    BigInt(value.coverage.fromBlock) < BigInt(value.pair.historyStart.blockNumber) ||
    BigInt(value.coverage.fromBlock) > BigInt(value.pair.activation.blockNumber) ||
    BigInt(value.coverage.untilBlock) < BigInt(value.pair.activation.blockNumber) ||
    value.coverage.fromTimestamp < value.pair.historyStart.timestamp ||
    value.coverage.fromTimestamp > value.pair.activation.timestamp ||
    value.coverage.untilTimestamp < value.pair.activation.timestamp
  ) context.addIssue({ code: "custom", message: "Trade-history state identity or coverage is invalid." });
  validateOrderedReferences(
    value.months,
    intersectedPeriods(value.coverage.fromTimestamp, value.coverage.untilTimestamp, "month")
      .map((month) => stockTokenTradePairMonthLogicalId(value.pair.pairId, month)),
    value.sequence,
    value.coverage,
    context,
  );
});
export type StockTokenTradeHistoryState = z.infer<typeof stockTokenTradeHistoryStateSchema>;

const pairMonthObjectSchema = jsonObject({
  contractVersion: z.literal("1"),
  coverage: stockTokenTradeCoverageIntervalSchema,
  days: z.array(stockTokenTradeHistoryFileReferenceSchema).min(1).max(31),
  kind: z.literal("pair_candle_month"),
  month: canonicalMonthSchema,
  pair: pairDescriptorSchema,
  sequence: positiveSafeIntegerSchema,
}).strict();
export const stockTokenTradeHistoryMonthSchema = pairMonthObjectSchema.superRefine((value, context) => {
  const entry = stockTokenTradeHistoryRegistry.pairs.find((candidate) => candidate.pair.pairId === value.pair.pairId);
  const monthStart = `${value.month}-01T00:00:00.000Z`;
  const monthUntil = new Date(monthStart);
  monthUntil.setUTCMonth(monthUntil.getUTCMonth() + 1);
  if (
    entry === undefined || !sameSerializedTradeHistoryValue(entry.pair, value.pair) ||
    value.coverage.fromTimestamp < monthStart || value.coverage.untilTimestamp > monthUntil.toISOString()
  ) context.addIssue({ code: "custom", message: "Trade-history month identity or coverage is invalid." });
  validateOrderedReferences(
    value.days,
    intersectedPeriods(value.coverage.fromTimestamp, value.coverage.untilTimestamp, "day")
      .map((day) => stockTokenTradePairDayLogicalId(value.pair.pairId, day)),
    value.sequence,
    value.coverage,
    context,
  );
});
export type StockTokenTradeHistoryMonth = z.infer<typeof stockTokenTradeHistoryMonthSchema>;

const pairDayObjectSchema = jsonObject({
  candles: z.array(stockTokenTradeHistoryFileCandleSchema).max(1_440),
  contractVersion: z.literal("1"),
  coverage: stockTokenTradeCoverageIntervalSchema,
  day: canonicalDaySchema,
  kind: z.literal("pair_candle_day"),
  pair: pairDescriptorSchema,
  sequence: positiveSafeIntegerSchema,
}).strict();
export const stockTokenTradeHistoryDaySchema = pairDayObjectSchema.superRefine((value, context) => {
  const entry = stockTokenTradeHistoryRegistry.pairs.find((candidate) => candidate.pair.pairId === value.pair.pairId);
  const dayStart = `${value.day}T00:00:00.000Z`;
  const dayUntil = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  if (
    entry === undefined || !sameSerializedTradeHistoryValue(entry.pair, value.pair) ||
    value.coverage.fromTimestamp < dayStart || value.coverage.untilTimestamp > dayUntil
  ) context.addIssue({ code: "custom", message: "Trade-history day identity or coverage is invalid." });
  let previous: StockTokenTradeHistoryFileCandle | undefined;
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
    ) context.addIssue({ code: "custom", message: "Trade-history day candle sequence is inconsistent." });
    for (const position of [candle.firstSource, candle.lastSource]) {
      if (recordSwapPositionIdentity(identities, position)) {
        context.addIssue({ code: "custom", message: "Trade candle Swap positions conflict." });
      }
    }
    previous = candle;
  }
});
export type StockTokenTradeHistoryDay = z.infer<typeof stockTokenTradeHistoryDaySchema>;

export interface StockTokenTradeHistoryMonthAdmission {
  readonly reference: StockTokenTradeMonthReference;
  readonly month: StockTokenTradeHistoryMonth;
  readonly sha256: string;
}
export interface StockTokenTradeHistoryDayAdmission {
  readonly reference: StockTokenTradeDayReference;
  readonly day: StockTokenTradeHistoryDay;
  readonly sha256: string;
}

export const stockTokenTradeHistoryUnavailableReasonSchema = z.enum([
  "asset_not_supported",
  "trade_history_unavailable",
  "trade_history_inconsistent",
  "outside_published_coverage",
]);
export type StockTokenTradeHistoryUnavailableReason = z.infer<typeof stockTokenTradeHistoryUnavailableReasonSchema>;
export const stockTokenTradeCoverageLimitationSchema = z.enum([
  "before_published_coverage",
  "after_published_coverage",
]);
export type StockTokenTradeCoverageLimitation = z.infer<typeof stockTokenTradeCoverageLimitationSchema>;

const tradeHistoryRequestWindowMilliseconds = maximumMarketTimeWindowMilliseconds;
const utcDayMilliseconds = 86_400_000;
const shortestUtcMonthMilliseconds = 28 * utcDayMilliseconds;
export const stockTokenTradeHistoryDataLimits = Object.freeze({
  coverageIntervals: Math.ceil(tradeHistoryRequestWindowMilliseconds / utcDayMilliseconds) + 1,
  dayFiles: Math.ceil(tradeHistoryRequestWindowMilliseconds / utcDayMilliseconds) + 1,
  monthFiles: Math.ceil(tradeHistoryRequestWindowMilliseconds / shortestUtcMonthMilliseconds) + 1,
  requestWindowMilliseconds: tradeHistoryRequestWindowMilliseconds,
  freshnessMilliseconds: 30 * 60 * 1_000,
});

const tradeHistoryDataCommon = {
  requestedStart: utcTimestampSchema,
  requestedEnd: utcTimestampSchema,
} as const;
export const stockTokenTradeHistoryDataUnavailableFields = {
  reason: stockTokenTradeHistoryUnavailableReasonSchema,
  ...tradeHistoryDataCommon,
} as const;
export const stockTokenTradeHistoryDataUnavailableSchema = jsonObject({
  status: z.literal("unavailable"),
  ...stockTokenTradeHistoryDataUnavailableFields,
}).strict();
export const stockTokenTradeHistoryDataAvailableFields = {
  ...tradeHistoryDataCommon,
  source: jsonObject({
    chainId: z.literal(productChainId),
    finality: z.literal("finalized"),
    poolManager: evmAddressSchema,
    poolId: hash32Schema,
    quoteToken: tradeHistoryQuoteTokenSchema,
  }).strict(),
  sourceFiles: jsonObject({
    contractVersion: z.literal("1"),
    pairId: hash32Schema,
    sequence: positiveSafeIntegerSchema,
    coveredUntilTimestamp: minuteTimestampSchema,
    stateSha256: sha256HexSchema,
    months: z.array(jsonObject({ month: canonicalMonthSchema, sha256: sha256HexSchema }).strict())
      .min(1).max(stockTokenTradeHistoryDataLimits.monthFiles),
    days: z.array(jsonObject({ day: canonicalDaySchema, sha256: sha256HexSchema }).strict())
      .min(1).max(stockTokenTradeHistoryDataLimits.dayFiles),
  }).strict(),
  freshness: z.enum(["current", "stale"]),
  coverage: jsonObject({
    status: z.enum(["complete", "partial"]),
    intervals: z.array(stockTokenTradeCoverageIntervalSchema)
      .min(1).max(stockTokenTradeHistoryDataLimits.coverageIntervals),
    limitations: z.array(stockTokenTradeCoverageLimitationSchema)
      .max(stockTokenTradeCoverageLimitationSchema.options.length),
  }).strict(),
  chart: stockTokenTradeHistoryChartSchema,
} as const;
export const stockTokenTradeHistoryDataAvailableSchema = jsonObject({
  status: z.literal("available"),
  ...stockTokenTradeHistoryDataAvailableFields,
}).strict();
const tradeHistoryDataUnionSchema = z.discriminatedUnion("status", [
  stockTokenTradeHistoryDataUnavailableSchema,
  stockTokenTradeHistoryDataAvailableSchema,
]);

const deriveChartPositionCoverage = (
  intervals: readonly StockTokenTradeCoverageInterval[],
  representedStart: string,
  representedEnd: string,
): StockTokenTradeHistoryChartPositionCoverage => {
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

export const stockTokenTradeHistoryDataSchema = tradeHistoryDataUnionSchema.superRefine((value, context) => {
  if (value.requestedStart >= value.requestedEnd) {
    context.addIssue({ code: "custom", message: "Trade-history data request interval is invalid." });
  }
  if (
    Date.parse(value.requestedEnd) - Date.parse(value.requestedStart) >
      stockTokenTradeHistoryDataLimits.requestWindowMilliseconds
  ) {
    context.addIssue({ code: "custom", message: "Trade-history data request interval exceeds 30 days." });
  }
  if (value.status !== "available") return;
  const expectedMonths = [...new Set(value.sourceFiles.days.map((entry) => entry.day.slice(0, 7)))];
  if (
    expectedMonths.length !== value.sourceFiles.months.length ||
    expectedMonths.some((month, index) => value.sourceFiles.months[index]?.month !== month)
  ) context.addIssue({ code: "custom", message: "Trade-history file month and day references disagree." });
  const asset = findStockTokenTradeHistoryAssetByPairId(value.source.poolId);
  if (
    asset === undefined || value.sourceFiles.pairId !== value.source.poolId ||
    value.source.chainId !== asset.pair.chainId || value.source.finality !== asset.pair.finality ||
    value.source.poolManager !== asset.pair.poolManager ||
    value.source.quoteToken.address !== asset.pair.quoteAsset.address ||
    value.source.quoteToken.decimals !== asset.pair.quoteAsset.decimals
  ) context.addIssue({ code: "custom", message: "Trade-history data source differs from its pair." });
  const chart = value.chart;
  if (
    chart.requestedStart !== value.requestedStart ||
    chart.requestedEnd !== value.requestedEnd ||
    chart.source.chainId !== value.source.chainId ||
    chart.source.finality !== value.source.finality ||
    chart.source.poolManager !== value.source.poolManager ||
    chart.source.poolId !== value.source.poolId ||
    chart.source.quoteToken.address !== value.source.quoteToken.address ||
    chart.source.quoteToken.decimals !== value.source.quoteToken.decimals ||
    chart.source.quoteToken.symbol !== value.source.quoteToken.symbol ||
    asset === undefined || chart.source.token.address !== asset.token ||
    chart.source.token.decimals !== asset.tokenDecimals ||
    chart.source.token.symbol !== asset.symbol
  ) context.addIssue({ code: "custom", message: "Trade-history chart series differs from its owner." });
  const projectionLengthsMatch = value.sourceFiles.days.length === value.coverage.intervals.length;
  if (
    value.sourceFiles.months.some((entry, index) => index > 0 &&
      entry.month <= value.sourceFiles.months[index - 1]!.month) ||
    value.sourceFiles.days.some((entry, index) => index > 0 &&
      entry.day <= value.sourceFiles.days[index - 1]!.day) ||
    !projectionLengthsMatch
  ) context.addIssue({ code: "custom", message: "Trade-history source-file projection is inconsistent." });
  if (!projectionLengthsMatch) return;
  for (let index = 0; index < value.coverage.intervals.length; index += 1) {
    const day = value.sourceFiles.days[index]!;
    const interval = value.coverage.intervals[index]!;
    const dayStart = `${day.day}T00:00:00.000Z`;
    const dayUntil = new Date(Date.parse(dayStart) + utcDayMilliseconds).toISOString();
    if (
      interval.fromTimestamp < dayStart || interval.untilTimestamp > dayUntil ||
      interval.untilTimestamp <= value.requestedStart || interval.fromTimestamp >= value.requestedEnd ||
      interval.untilTimestamp > value.sourceFiles.coveredUntilTimestamp
    ) context.addIssue({ code: "custom", message: "Trade-history source-file coverage is inconsistent." });
  }
  for (let index = 1; index < value.coverage.intervals.length; index += 1) {
    const previous = value.coverage.intervals[index - 1]!;
    const current = value.coverage.intervals[index]!;
    if (previous.untilTimestamp !== current.fromTimestamp || previous.untilBlock !== current.fromBlock) {
      context.addIssue({ code: "custom", message: "Trade-history data coverage is not continuous." });
    }
  }
  const seriesIdentities = createSwapPositionIdentityState();
  for (let index = 0; index < chart.positions.length; index += 1) {
    const position = chart.positions[index]!;
    const expectedCoverage = deriveChartPositionCoverage(
      value.coverage.intervals,
      position.representedStart,
      position.representedEnd,
    );
    if (
      position.coverage !== expectedCoverage ||
      (expectedCoverage === "unavailable" && position.candle !== null)
    ) context.addIssue({ code: "custom", message: "Trade-history chart coverage is inconsistent." });
    const aggregate = position.candle;
    if (aggregate === null) continue;
    const covered = value.coverage.intervals.some((interval) =>
      aggregate.observedStart >= interval.fromTimestamp &&
      aggregate.observedEnd <= interval.untilTimestamp &&
      BigInt(aggregate.firstSource.blockNumber) >= BigInt(interval.fromBlock) &&
      BigInt(aggregate.lastSource.blockNumber) < BigInt(interval.untilBlock));
    const firstIdentityConflict = recordSwapPositionIdentity(seriesIdentities, aggregate.firstSource);
    const lastIdentityConflict = recordSwapPositionIdentity(seriesIdentities, aggregate.lastSource);
    if (!covered || firstIdentityConflict || lastIdentityConflict) {
      context.addIssue({ code: "custom", message: "Trade-history chart source is inconsistent." });
    }
  }
  const expected = new Set<StockTokenTradeCoverageLimitation>();
  if (value.coverage.intervals[0]!.fromTimestamp > value.requestedStart) {
    expected.add("before_published_coverage");
  }
  if (value.coverage.intervals.at(-1)!.untilTimestamp < value.requestedEnd) {
    expected.add("after_published_coverage");
  }
  const stale = Date.parse(value.requestedEnd) - Date.parse(value.sourceFiles.coveredUntilTimestamp) >
    stockTokenTradeHistoryDataLimits.freshnessMilliseconds;
  const ordered = stockTokenTradeCoverageLimitationSchema.options.filter((limitation) =>
    expected.has(limitation));
  if (
    value.freshness !== (stale ? "stale" : "current") ||
    value.coverage.limitations.join("\0") !== ordered.join("\0") ||
    value.coverage.status !== (ordered.length === 0 ? "complete" : "partial")
  ) context.addIssue({ code: "custom", message: "Trade-history data derived state is inconsistent." });
});
export type StockTokenTradeHistoryData = z.infer<typeof stockTokenTradeHistoryDataSchema>;

export interface StockTokenTradeHistoryReadInput {
  readonly pairId: string;
  readonly window: MarketTimeWindow;
  readonly requestedStart: string;
  readonly requestedEnd: string;
}
export interface StockTokenTradeHistoryReadPort {
  read(input: StockTokenTradeHistoryReadInput, signal?: AbortSignal): Promise<StockTokenTradeHistoryData>;
}

const exactReference = (
  references: readonly StockTokenTradeHistoryFileReference[],
  candidate: StockTokenTradeHistoryFileReference,
): StockTokenTradeHistoryFileReference | undefined => references.find((reference) =>
  sameSerializedTradeHistoryValue(reference, candidate));
const overlaps = (coverage: StockTokenTradeCoverageInterval, from: string, until: string): boolean =>
  coverage.untilTimestamp > from && coverage.fromTimestamp < until;
const limitationOrder = stockTokenTradeCoverageLimitationSchema.options;

interface TradeHistoryChartAggregateState {
  readonly open: z.infer<typeof exactRationalSchema>;
  high: z.infer<typeof exactRationalSchema>;
  low: z.infer<typeof exactRationalSchema>;
  close: z.infer<typeof exactRationalSchema>;
  readonly firstSource: StockTokenTradeSwapPosition;
  lastSource: StockTokenTradeSwapPosition;
  readonly observedStart: string;
  observedEnd: string;
  quoteVolumeRaw: bigint;
  sourceCandleCount: number;
  tokenVolumeRaw: bigint;
  tradeCount: bigint;
}

const createStockTokenTradeHistoryChart = (input: Readonly<{
  request: StockTokenTradeHistoryReadInput;
  asset: StockTokenTradeHistoryAsset;
  intervals: readonly StockTokenTradeCoverageInterval[];
  candles: readonly StockTokenTradeCandle[];
}>): StockTokenTradeHistoryChart => {
  const frames = tradeHistoryChartPositionFrames(
    input.request.window,
    input.request.requestedStart,
    input.request.requestedEnd,
  );
  const definition = stockTokenTradeHistoryChartWindowDefinitions[input.request.window];
  if (frames.length > definition.maximumPositionCount || frames.length === 0) {
    throw new TypeError("Trade-history chart position count exceeds its window bound.");
  }
  const firstIntervalStart = Date.parse(frames[0]!.intervalStart);
  const aggregates = new Array<TradeHistoryChartAggregateState | undefined>(frames.length);
  for (const candle of input.candles) {
    const candleStart = Date.parse(candle.intervalStart);
    const index = Math.floor(
      (candleStart - firstIntervalStart) / definition.intervalMilliseconds,
    );
    const frame = frames[index];
    if (
      frame === undefined || candle.intervalStart < frame.intervalStart ||
      candle.intervalEnd > frame.intervalEnd
    ) throw new TypeError("Trade candle does not belong to one chart position.");
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
    ) throw new TypeError("Trade-history chart source candle sequence is invalid.");
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
      throw new TypeError("Trade-history chart position contains too many source candles.");
    }
    return {
      ...frame,
      coverage: deriveChartPositionCoverage(
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
  return deepFreezeValue(stockTokenTradeHistoryChartSchema.parse({
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

export const createStockTokenTradeHistoryData = (input: Readonly<{
  request: StockTokenTradeHistoryReadInput;
  asset: StockTokenTradeHistoryAsset;
  state: StockTokenTradeHistoryState;
  stateSha256: string;
  months: readonly StockTokenTradeHistoryMonthAdmission[];
  days: readonly StockTokenTradeHistoryDayAdmission[];
}>): StockTokenTradeHistoryData => {
  const asset = tradeHistoryAssetSchema.parse(input.asset);
  const registeredAsset = findStockTokenTradeHistoryAssetByPairId(asset.poolId);
  if (registeredAsset === undefined || !sameSerializedTradeHistoryValue(registeredAsset, asset)) {
    throw new TypeError("Trade-history asset differs from the admitted registry.");
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
    throw new TypeError("Trade-history request identity or interval is invalid.");
  }
  const state = stockTokenTradeHistoryStateSchema.parse(input.state);
  const stateSha256 = sha256HexSchema.parse(input.stateSha256);
  if (
    state.pair.pairId !== asset.poolId || !sameSerializedTradeHistoryValue(state.pair, asset.pair) ||
    sha256Bytes(new TextEncoder().encode(serializeStockTokenTradeHistoryFileJson(state))) !== stateSha256
  ) throw new TypeError("Trade-history selected state is inconsistent.");

  const stateIntersectionFrom = request.requestedStart > state.coverage.fromTimestamp
    ? request.requestedStart : state.coverage.fromTimestamp;
  const stateIntersectionUntil = request.requestedEnd < state.coverage.untilTimestamp
    ? request.requestedEnd : state.coverage.untilTimestamp;
  if (stateIntersectionFrom >= stateIntersectionUntil) {
    if (input.months.length !== 0 || input.days.length !== 0) {
      throw new TypeError("Trade-history read retained files outside selected coverage.");
    }
    return unavailableStockTokenTradeHistoryData(request, "outside_published_coverage");
  }

  const requiredMonthReferences = state.months.filter((reference) =>
    overlaps(reference.coverage, stateIntersectionFrom, stateIntersectionUntil));
  const months = input.months.map((entry) => ({
    reference: stockTokenTradeHistoryFileReferenceSchema.parse(entry.reference),
    month: stockTokenTradeHistoryMonthSchema.parse(entry.month),
    sha256: sha256HexSchema.parse(entry.sha256),
  })).sort((left, right) => compareCodePointSequences(left.month.month, right.month.month));
  if (months.length !== requiredMonthReferences.length) {
    throw new TypeError("Trade-history pair-month files do not cover the selected pair state.");
  }
  for (const entry of months) {
    if (
      exactReference(requiredMonthReferences, entry.reference) === undefined ||
      entry.month.pair.pairId !== asset.poolId ||
      entry.reference.logicalId !== stockTokenTradePairMonthLogicalId(asset.poolId, entry.month.month) ||
      entry.reference.sequence !== entry.month.sequence ||
      !sameSerializedTradeHistoryValue(entry.reference.coverage, entry.month.coverage) ||
      entry.reference.jsonSha256 !== entry.sha256 ||
      sha256Bytes(new TextEncoder().encode(serializeStockTokenTradeHistoryFileJson(entry.month))) !== entry.sha256
    ) throw new TypeError("Trade-history state and month admissions are not correlated.");
  }

  const requiredDayReferences = months.flatMap((entry) => entry.month.days)
    .filter((reference) => overlaps(reference.coverage, stateIntersectionFrom, stateIntersectionUntil));
  const days = input.days.map((entry) => ({
    reference: stockTokenTradeHistoryFileReferenceSchema.parse(entry.reference),
    day: stockTokenTradeHistoryDaySchema.parse(entry.day),
    sha256: sha256HexSchema.parse(entry.sha256),
  })).sort((left, right) => compareCodePointSequences(left.day.day, right.day.day));
  if (days.length !== requiredDayReferences.length) {
    throw new TypeError("Trade-history pair-day files do not cover the selected pair months.");
  }
  for (const entry of days) {
    if (
      exactReference(requiredDayReferences, entry.reference) === undefined ||
      entry.day.pair.pairId !== asset.poolId ||
      entry.reference.logicalId !== stockTokenTradePairDayLogicalId(asset.poolId, entry.day.day) ||
      entry.reference.sequence !== entry.day.sequence ||
      !sameSerializedTradeHistoryValue(entry.reference.coverage, entry.day.coverage) ||
      entry.reference.jsonSha256 !== entry.sha256 ||
      sha256Bytes(new TextEncoder().encode(serializeStockTokenTradeHistoryFileJson(entry.day))) !== entry.sha256
    ) throw new TypeError("Trade-history month and day admissions are not correlated.");
  }

  const intervals = days.map((entry) => entry.day.coverage);
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1]!;
    const current = intervals[index]!;
    if (
      previous.untilTimestamp !== current.fromTimestamp || previous.untilBlock !== current.fromBlock
    ) throw new TypeError("Trade-history merged coverage is not continuous.");
  }
  let previousFileCandle: StockTokenTradeHistoryFileCandle | undefined;
  const fileCandles = days.flatMap((entry) => entry.day.candles);
  const fileIdentities = createSwapPositionIdentityState();
  for (const candle of fileCandles) {
    if (previousFileCandle !== undefined && (
      candle.intervalStart <= previousFileCandle.intervalStart ||
      BigInt(previousFileCandle.lastSource.blockNumber) >= BigInt(candle.firstSource.blockNumber)
    )) throw new TypeError("Trade-history merged candle sequence is inconsistent.");
    const firstIdentityConflict = recordSwapPositionIdentity(fileIdentities, candle.firstSource);
    const lastIdentityConflict = recordSwapPositionIdentity(fileIdentities, candle.lastSource);
    if (firstIdentityConflict || lastIdentityConflict) {
      throw new TypeError("Trade-history merged candle Swap positions conflict.");
    }
    previousFileCandle = candle;
  }
  const sourceCandles = fileCandles
    .filter((candle) => candle.intervalStart >= request.requestedStart && candle.intervalEnd <= request.requestedEnd)
    .map((candle) => {
      const { baseVolumeRaw, ...rest } = candle;
      return stockTokenTradeCandleSchema.parse({
        ...rest,
        symbol: asset.symbol,
        token: asset.token,
        poolId: asset.poolId,
        tokenVolumeRaw: baseVolumeRaw,
      });
    });
  const chart = createStockTokenTradeHistoryChart({
    request,
    asset,
    intervals,
    candles: sourceCandles,
  });
  const stale = Date.parse(request.requestedEnd) - Date.parse(state.coverage.untilTimestamp) >
    stockTokenTradeHistoryDataLimits.freshnessMilliseconds;
  const limitations = new Set<StockTokenTradeCoverageLimitation>();
  if (stateIntersectionFrom > request.requestedStart) limitations.add("before_published_coverage");
  if (stateIntersectionUntil < request.requestedEnd) limitations.add("after_published_coverage");
  const orderedLimitations = limitationOrder.filter((limitation) => limitations.has(limitation));
  const quote = asset.pair.quoteAsset;
  return deepFreezeValue(stockTokenTradeHistoryDataSchema.parse({
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
    sourceFiles: {
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
    chart,
  }));
};

export const unavailableStockTokenTradeHistoryData = (
  input: Pick<StockTokenTradeHistoryReadInput, "requestedStart" | "requestedEnd">,
  reason: StockTokenTradeHistoryUnavailableReason,
): StockTokenTradeHistoryData => deepFreezeValue(stockTokenTradeHistoryDataSchema.parse({
  status: "unavailable",
  reason,
  requestedStart: input.requestedStart,
  requestedEnd: input.requestedEnd,
}));
