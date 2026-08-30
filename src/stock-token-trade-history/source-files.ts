import { gunzipSync } from "node:zlib";

import { z } from "zod";

import {
  evmAddressSchema,
  hash32Schema,
  jsonObject,
  keccak256FromHex,
  sha256Bytes,
  uint256DecimalSchema,
} from "../core/index.js";
import {
  stockTokenTradeHistorySourceContract,
  stockTokenTradeHistorySourceInternalSchemas,
  stockTokenTradeHistorySourceResolution,
  stockTokenTradeHistorySourceResolutionLabels,
  type StockTokenTradeHistoryCoverageSegment,
  type StockTokenTradeHistorySelectedBase,
  type StockTokenTradeHistorySelectedRoot,
  type StockTokenTradeHistorySourceResolution,
  type StockTokenTradeHistorySourceLimits,
  type StockTokenTradeHistorySourceResolutionLabel,
} from "./source-contract.js";

const {
  hexSha256,
  minuteTimestamp,
  nonnegativeSafeInteger,
  positiveSafeInteger,
  utcMonth,
  wholeSecondTimestamp,
} = stockTokenTradeHistorySourceInternalSchemas;

const maximumInt128Magnitude = 1n << 127n;
const maximumMinuteTradeCount = BigInt(Number.MAX_SAFE_INTEGER);
const maximumResolutionMinutes = 2_880n;
const maximumDerivedTradeCount = maximumResolutionMinutes * maximumMinuteTradeCount;
const maximumDerivedVolume = maximumDerivedTradeCount * maximumInt128Magnitude;
const maximumPriceNumerator = maximumInt128Magnitude * 10n ** 255n;
const maximumPriceDenominator = maximumInt128Magnitude * 10n ** 6n;

export class StockTokenTradeHistorySourceCapacityError extends Error {
  constructor() {
    super("Stock Token trade-history source capacity was exceeded.");
    this.name = "StockTokenTradeHistorySourceCapacityError";
  }
}

export class StockTokenTradeHistorySourceIntegrityError extends Error {
  constructor() {
    super("Stock Token trade-history source is inconsistent.");
    this.name = "StockTokenTradeHistorySourceIntegrityError";
  }
}

const sourceIntegrity = (): never => {
  throw new StockTokenTradeHistorySourceIntegrityError();
};

const canonicalJson = (value: unknown, depth = 0): string => {
  if (depth > 64) return sourceIntegrity();
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return sourceIntegrity();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((member) => canonicalJson(member, depth + 1)).join(",")}]`;
  }
  if (typeof value !== "object") return sourceIntegrity();
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => {
    const member = record[key];
    if (member === undefined) return sourceIntegrity();
    return `${JSON.stringify(key)}:${canonicalJson(member, depth + 1)}`;
  }).join(",")}}`;
};

export interface DecodedStockTokenTradeHistorySourceFile {
  readonly value: unknown;
  readonly jsonBytes: Uint8Array;
  readonly jsonSha256: string;
}

export const decodeStockTokenTradeHistorySourceFile = (
  gzipBytes: Uint8Array,
  maximumDecodedBytes: number,
): DecodedStockTokenTradeHistorySourceFile => {
  let jsonBytes: Uint8Array;
  try {
    jsonBytes = gunzipSync(gzipBytes, { maxOutputLength: maximumDecodedBytes });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_BUFFER_TOO_LARGE"
    ) throw new StockTokenTradeHistorySourceCapacityError();
    return sourceIntegrity();
  }
  if (jsonBytes.byteLength > maximumDecodedBytes) {
    throw new StockTokenTradeHistorySourceCapacityError();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes)) as unknown;
  } catch {
    return sourceIntegrity();
  }
  const canonical = new TextEncoder().encode(canonicalJson(value));
  if (canonical.length !== jsonBytes.byteLength) {
    return sourceIntegrity();
  }
  if (canonical.some((byte, index) => byte !== jsonBytes[index])) return sourceIntegrity();
  return Object.freeze({
    value,
    jsonBytes,
    jsonSha256: sha256Bytes(jsonBytes),
  });
};

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

const compareRationals = (
  left: Readonly<{ readonly numerator: string; readonly denominator: string }>,
  right: Readonly<{ readonly numerator: string; readonly denominator: string }>,
): number => {
  const difference = BigInt(left.numerator) * BigInt(right.denominator) -
    BigInt(right.numerator) * BigInt(left.denominator);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
};

const priceHasAdmittedSwapAmounts = (
  price: Readonly<{ readonly numerator: string; readonly denominator: string }>,
  baseDecimals: number,
): boolean => {
  const quoteScaled = BigInt(price.numerator) * 10n ** 6n;
  const baseScaled = BigInt(price.denominator) * 10n ** BigInt(baseDecimals);
  const divisor = gcd(quoteScaled, baseScaled);
  return quoteScaled / divisor <= maximumInt128Magnitude &&
    baseScaled / divisor <= maximumInt128Magnitude;
};

const comparePositions = (
  left: Readonly<{ readonly blockNumber: string; readonly transactionIndex: number; readonly logIndex: number }>,
  right: Readonly<{ readonly blockNumber: string; readonly transactionIndex: number; readonly logIndex: number }>,
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
  if (hex.length > bytes * 2) return sourceIntegrity();
  return hex.padStart(64, "0");
};

const derivePoolId = (poolKey: Readonly<{
  readonly currency0: string;
  readonly currency1: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: string;
}>): string => keccak256FromHex(`0x${[
  abiWord(poolKey.currency0, 20),
  abiWord(poolKey.currency1, 20),
  abiWord(BigInt(poolKey.fee), 3),
  abiWord(BigInt(poolKey.tickSpacing), 3),
  abiWord(poolKey.hooks, 20),
].join("")}`);

const logicalId = (address: string, kind: "state" | "month" | "resolution", part?: string): string =>
  kind === "state"
    ? `base/${address}/state`
    : kind === "month"
      ? `base/${address}/month/${part}`
      : `base/${address}/resolution/${part}`;

const parseLogicalId = (value: string): Readonly<{
  readonly address: string;
  readonly kind: "state" | "month" | "day" | "resolution";
  readonly period?: string;
  readonly resolution?: StockTokenTradeHistorySourceResolutionLabel;
}> | undefined => {
  const state = value.match(/^base\/(0x[0-9a-f]{40})\/state$/u);
  if (state !== null) return Object.freeze({ address: state[1]!, kind: "state" });
  const period = value.match(/^base\/(0x[0-9a-f]{40})\/(month|day)\/(.+)$/u);
  if (period !== null) {
    const validPeriod = period[2] === "month"
      ? /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])$/u.test(period[3]!)
      : (() => {
          if (!/^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/u.test(period[3]!)) {
            return false;
          }
          const date = new Date(`${period[3]}T00:00:00.000Z`);
          return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === period[3];
        })();
    return validPeriod
      ? Object.freeze({ address: period[1]!, kind: period[2] as "month" | "day", period: period[3]! })
      : undefined;
  }
  const resolution = value.match(
    /^base\/(0x[0-9a-f]{40})\/resolution\/([^/]+)\/((?:[0-9]{4})-(?:0[1-9]|1[0-2]))$/u,
  );
  if (resolution === null || !stockTokenTradeHistorySourceResolutionLabels.includes(
    resolution[2] as StockTokenTradeHistorySourceResolutionLabel,
  )) return undefined;
  return Object.freeze({
    address: resolution[1]!,
    kind: "resolution",
    period: resolution[3]!,
    resolution: resolution[2] as StockTokenTradeHistorySourceResolutionLabel,
  });
};

export interface StoredMemberReference {
  readonly assetSha256: string;
  readonly from: number;
  readonly gzipSha256: string;
  readonly jsonBytes: number;
  readonly jsonSha256: string;
  readonly logicalId: string;
  readonly until: number;
}

export interface SelectedAssetEntry {
  readonly assetName: string;
  readonly bytes: number;
  readonly logicalIds: readonly string[];
  readonly releaseTag: string;
  readonly sha256: string;
}

export interface SelectedRootFile {
  readonly assets: readonly SelectedAssetEntry[];
  readonly baseCurrencies: Readonly<Record<string, StoredMemberReference>>;
  readonly currentUntil: StockTokenTradeHistorySelectedRoot["currentUntil"];
  readonly poolManager: StockTokenTradeHistorySelectedRoot["poolManager"];
  readonly publicationSequence: number;
  readonly resolutions: readonly StockTokenTradeHistorySourceResolution[];
  readonly usdgAddress: StockTokenTradeHistorySelectedRoot["usdgAddress"];
  readonly usdgDecimals: number;
}

export interface BaseStateFile {
  readonly baseCurrencyAddress: StockTokenTradeHistorySelectedBase["baseCurrencyAddress"];
  readonly decimals: number;
  readonly months: readonly StoredMemberReference[];
  readonly poolPeriods: readonly StockTokenTradeHistoryCoverageSegment[];
  readonly pools: StockTokenTradeHistorySelectedBase["pools"];
}

export interface BaseMonthFile {
  readonly baseCurrencyAddress: string;
  readonly coverage: readonly StockTokenTradeHistoryCoverageSegment[];
  readonly days: readonly StoredMemberReference[];
  readonly month: string;
  readonly resolutions: Readonly<Record<StockTokenTradeHistorySourceResolutionLabel, StoredMemberReference>>;
}

export interface BaseResolutionFile {
  readonly baseCurrencyAddress: string;
  readonly candles: readonly z.infer<ReturnType<typeof createSourceFileSchemas>["resolutionCandle"]>[];
  readonly coverage: readonly StockTokenTradeHistoryCoverageSegment[];
  readonly intervalSeconds: number;
  readonly ownerMonth: string;
}

const sourceValueCount = (value: unknown, key: string): number | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const member = (value as Readonly<Record<string, unknown>>)[key];
  if (Array.isArray(member)) return member.length;
  if (member !== null && typeof member === "object") return Object.keys(member).length;
  return undefined;
};

export const createSourceFileSchemas = (limits: StockTokenTradeHistorySourceLimits) => {
  const blockNumber = uint256DecimalSchema;
  const volume = digits(maximumDerivedVolume.toString().length, true);
  const tradeCount = digits(maximumDerivedTradeCount.toString().length, true);
  const rational = jsonObject({
    numerator: digits(maximumPriceNumerator.toString().length, true),
    denominator: digits(maximumPriceDenominator.toString().length, true),
  }).strict().superRefine((value, context) => {
    if (gcd(BigInt(value.numerator), BigInt(value.denominator)) !== 1n) {
      context.addIssue({ code: "custom", message: "Source rational is not reduced." });
    }
  });
  const boundary = jsonObject({ blockNumber, timestamp: minuteTimestamp }).strict();
  const initializeBoundary = jsonObject({ blockNumber, timestamp: wholeSecondTimestamp }).strict();
  const coverageSegment = jsonObject({
    fromBlock: blockNumber,
    fromTimestamp: minuteTimestamp,
    poolId: hash32Schema,
    untilBlock: blockNumber,
    untilTimestamp: minuteTimestamp,
  }).strict().superRefine((value, context) => {
    if (
      BigInt(value.fromBlock) > BigInt(value.untilBlock) ||
      Date.parse(value.fromTimestamp) >= Date.parse(value.untilTimestamp)
    ) context.addIssue({ code: "custom", message: "Source coverage is invalid." });
  });
  const reference = jsonObject({
    assetSha256: hexSha256,
    from: nonnegativeSafeInteger,
    gzipSha256: hexSha256,
    jsonBytes: positiveSafeInteger,
    jsonSha256: hexSha256,
    logicalId: z.string().min(1).max(128),
    until: positiveSafeInteger,
  }).strict().superRefine((value, context) => {
    if (value.from >= value.until || parseLogicalId(value.logicalId) === undefined) {
      context.addIssue({ code: "custom", message: "Stored member reference is invalid." });
    }
  });
  const asset = jsonObject({
    assetName: z.string().min(1).max(256),
    bytes: positiveSafeInteger.max(stockTokenTradeHistorySourceContract.maximumPhysicalAssetBytes),
    logicalIds: z.array(z.string().min(1).max(128)).min(1),
    releaseTag: z.string().min(1).max(256),
    sha256: hexSha256,
  }).strict();
  const resolutionEntry = jsonObject({
    label: z.string().min(1).max(4),
    intervalSeconds: positiveSafeInteger,
    partition: z.enum(["day", "month"]),
  }).strict();
  const root = jsonObject({
    assets: z.array(asset).min(1),
    baseCurrencies: z.record(evmAddressSchema, reference),
    currentUntil: boundary,
    poolManager: z.literal(stockTokenTradeHistorySourceContract.poolManager),
    publicationSequence: positiveSafeInteger,
    resolutions: z.array(resolutionEntry).length(stockTokenTradeHistorySourceContract.resolutions.length),
    usdgAddress: z.literal(stockTokenTradeHistorySourceContract.usdgAddress),
    usdgDecimals: z.literal(stockTokenTradeHistorySourceContract.usdgDecimals),
  }).strict();
  const poolKey = jsonObject({
    currency0: evmAddressSchema,
    currency1: evmAddressSchema,
    fee: z.number().int().nonnegative().max(2 ** 24 - 1),
    hooks: evmAddressSchema,
    tickSpacing: z.number().int().positive().max(2 ** 23 - 1),
  }).strict();
  const poolFacts = jsonObject({
    historyFrom: boundary,
    initialize: initializeBoundary,
    poolKey,
    sourceFrom: boundary,
  }).strict();
  const state = jsonObject({
    baseCurrencyAddress: evmAddressSchema,
    decimals: z.number().int().nonnegative().max(255),
    months: z.array(reference).min(1),
    poolPeriods: z.array(coverageSegment).min(1),
    pools: z.record(hash32Schema, poolFacts),
  }).strict();
  const monthResolutions = jsonObject(Object.fromEntries(
    stockTokenTradeHistorySourceResolutionLabels.map((label) => [label, reference]),
  ) as Record<StockTokenTradeHistorySourceResolutionLabel, typeof reference>).strict();
  const month = jsonObject({
    baseCurrencyAddress: evmAddressSchema,
    coverage: z.array(coverageSegment).min(1),
    days: z.array(reference).min(1),
    month: utcMonth,
    resolutions: monthResolutions,
  }).strict();
  const swapPosition = jsonObject({
    blockHash: hash32Schema,
    blockNumber,
    logIndex: nonnegativeSafeInteger,
    transactionHash: hash32Schema,
    transactionIndex: nonnegativeSafeInteger,
  }).strict();
  const resolutionCandle = jsonObject({
    baseVolumeRaw: volume,
    close: rational,
    firstSource: swapPosition,
    high: rational,
    intervalEnd: minuteTimestamp,
    intervalStart: minuteTimestamp,
    lastSource: swapPosition,
    low: rational,
    observedEnd: minuteTimestamp,
    observedStart: minuteTimestamp,
    open: rational,
    quoteVolumeRaw: volume,
    sourceCandleCount: positiveSafeInteger,
    tradeCount,
  }).strict();
  const resolution = jsonObject({
    baseCurrencyAddress: evmAddressSchema,
    candles: z.array(resolutionCandle),
    coverage: z.array(coverageSegment).min(1),
    intervalSeconds: positiveSafeInteger,
    ownerMonth: utcMonth,
  }).strict();
  return Object.freeze({
    reference,
    root,
    state,
    month,
    resolution,
    resolutionCandle,
  });
};

const strictlyOrderedUnique = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || value > values[index - 1]!);

export const validateCoverageSequence = (
  coverage: readonly StockTokenTradeHistoryCoverageSegment[],
): void => {
  let previous: StockTokenTradeHistoryCoverageSegment | undefined;
  for (const segment of coverage) {
    if (previous !== undefined && (
      previous.untilBlock !== segment.fromBlock ||
      previous.untilTimestamp !== segment.fromTimestamp
    )) return sourceIntegrity();
    previous = segment;
  }
};

const validateAssetEntry = (entry: SelectedAssetEntry): void => {
  const data = entry.releaseTag.match(/^market-data-(\d{4}-\d{2})-s[1-9][0-9]*$/u);
  const index = entry.releaseTag.match(/^market-data-index-s([1-9][0-9]*)$/u);
  const dataSequence = data === null ? undefined : Number(entry.releaseTag.split("-s").at(-1));
  const indexSequence = index === null ? undefined : Number(index[1]);
  if (
    entry.assetName !== `data-${entry.sha256}.bin` &&
    entry.assetName !== `index-${entry.sha256}.bin`
  ) return sourceIntegrity();
  if (entry.assetName.startsWith("data-") !== (data !== null) ||
    entry.assetName.startsWith("index-") !== (index !== null) ||
      data !== null && (!Number.isSafeInteger(dataSequence) || (dataSequence ?? 0) <= 0) ||
      index !== null && (!Number.isSafeInteger(indexSequence) || (indexSequence ?? 0) <= 0) ||
      !strictlyOrderedUnique(entry.logicalIds)) return sourceIntegrity();
  const kinds = new Set<string>();
  for (const id of entry.logicalIds) {
    const parsed = parseLogicalId(id);
    if (parsed === undefined) return sourceIntegrity();
    if (entry.assetName.startsWith("data-") && parsed.kind !== "day" && parsed.kind !== "resolution") {
      return sourceIntegrity();
    }
    if (entry.assetName.startsWith("index-") && parsed.kind !== "state" && parsed.kind !== "month") {
      return sourceIntegrity();
    }
    if (data !== null && (parsed.period?.slice(0, 7) !== data[1])) return sourceIntegrity();
    kinds.add(parsed.kind);
  }
  if (entry.assetName.startsWith("index-") && kinds.size !== 1) return sourceIntegrity();
};

export const parseSelectedRootFile = (
  value: unknown,
  limits: StockTokenTradeHistorySourceLimits,
): SelectedRootFile => {
  let root: SelectedRootFile;
  try {
    root = createSourceFileSchemas(limits).root.parse(value) as SelectedRootFile;
  } catch {
    return sourceIntegrity();
  }
  if (root.assets.length > limits.rootAssets ||
      Object.keys(root.baseCurrencies).length > limits.rootBaseCurrencies) {
    throw new StockTokenTradeHistorySourceCapacityError();
  }
  if (canonicalJson(root.resolutions) !== canonicalJson(stockTokenTradeHistorySourceContract.resolutions)) {
    return sourceIntegrity();
  }
  if (Object.keys(root.baseCurrencies).length === 0) return sourceIntegrity();
  const assetDigests = root.assets.map((entry) => entry.sha256);
  if (!strictlyOrderedUnique(assetDigests)) return sourceIntegrity();
  const membership = new Map<string, SelectedAssetEntry>();
  let logicalCount = 0;
  for (const asset of root.assets) {
    validateAssetEntry(asset);
    logicalCount += asset.logicalIds.length;
    if (logicalCount > limits.rootLogicalIds) throw new StockTokenTradeHistorySourceCapacityError();
    for (const id of asset.logicalIds) {
      if (membership.has(id)) return sourceIntegrity();
      membership.set(id, asset);
    }
  }
  for (const [address, reference] of Object.entries(root.baseCurrencies)) {
    const selectedAsset = membership.get(reference.logicalId);
    if (reference.logicalId !== logicalId(address, "state") ||
        selectedAsset?.sha256 !== reference.assetSha256 ||
        reference.until > (selectedAsset?.bytes ?? 0)) return sourceIntegrity();
  }
  return root;
};

const validatePoolKey = (
  key: BaseStateFile["pools"][string]["poolKey"],
  poolId: string,
  baseCurrencyAddress: string,
): void => {
  const baseIsCurrency0 = key.currency0 === baseCurrencyAddress;
  if (
    BigInt(key.currency0) >= BigInt(key.currency1) ||
    !(baseIsCurrency0 && key.currency1 === stockTokenTradeHistorySourceContract.usdgAddress ||
      key.currency1 === baseCurrencyAddress && key.currency0 === stockTokenTradeHistorySourceContract.usdgAddress) ||
    derivePoolId(key) !== poolId
  ) return sourceIntegrity();
};

export const parseBaseStateFile = (
  value: unknown,
  address: string,
  decimals: number,
  limits: StockTokenTradeHistorySourceLimits,
): BaseStateFile => {
  const periods = sourceValueCount(value, "poolPeriods");
  const pools = sourceValueCount(value, "pools");
  const months = sourceValueCount(value, "months");
  if (periods !== undefined && periods > limits.statePoolPeriods ||
      pools !== undefined && pools > limits.statePools ||
      months !== undefined && months > limits.stateMonths) {
    throw new StockTokenTradeHistorySourceCapacityError();
  }
  let state: BaseStateFile;
  try {
    state = createSourceFileSchemas(limits).state.parse(value) as BaseStateFile;
  } catch {
    return sourceIntegrity();
  }
  if (state.baseCurrencyAddress !== address || state.decimals !== decimals) return sourceIntegrity();
  if (Object.keys(state.pools).length === 0) return sourceIntegrity();
  validateCoverageSequence(state.poolPeriods);
  for (const [poolId, facts] of Object.entries(state.pools)) {
    validatePoolKey(facts.poolKey, poolId, address);
    const owned = state.poolPeriods.filter((period) => period.poolId === poolId);
    if (owned.length === 0 ||
        owned[0]!.fromBlock !== facts.historyFrom.blockNumber ||
        owned[0]!.fromTimestamp !== facts.historyFrom.timestamp) return sourceIntegrity();
  }
  if (state.poolPeriods.some((period) => state.pools[period.poolId] === undefined)) {
    return sourceIntegrity();
  }
  const monthIds = state.months.map((reference) => reference.logicalId);
  if (!strictlyOrderedUnique(monthIds)) return sourceIntegrity();
  for (const reference of state.months) {
    const parsed = parseLogicalId(reference.logicalId);
    if (parsed?.kind !== "month" || parsed.address !== address ||
        reference.logicalId !== logicalId(address, "month", parsed.period)) return sourceIntegrity();
  }
  return state;
};

export const parseBaseMonthFile = (
  value: unknown,
  address: string,
  ownerMonth: string,
  limits: StockTokenTradeHistorySourceLimits,
): BaseMonthFile => {
  const coverage = sourceValueCount(value, "coverage");
  const days = sourceValueCount(value, "days");
  if (coverage !== undefined && coverage > limits.monthCoverageSegments ||
      days !== undefined && days > limits.monthDayReferences) {
    throw new StockTokenTradeHistorySourceCapacityError();
  }
  let month: BaseMonthFile;
  try {
    month = createSourceFileSchemas(limits).month.parse(value) as BaseMonthFile;
  } catch {
    return sourceIntegrity();
  }
  if (month.baseCurrencyAddress !== address || month.month !== ownerMonth) return sourceIntegrity();
  validateCoverageSequence(month.coverage);
  const monthStart = `${ownerMonth}-01T00:00:00.000Z`;
  const monthEnd = new Date(monthStart);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  if (month.coverage.some((segment) =>
    segment.fromTimestamp < monthStart || segment.untilTimestamp > monthEnd.toISOString())) {
    return sourceIntegrity();
  }
  const dayIds = month.days.map((reference) => reference.logicalId);
  if (!strictlyOrderedUnique(dayIds)) return sourceIntegrity();
  for (const reference of month.days) {
    const parsed = parseLogicalId(reference.logicalId);
    if (parsed?.kind !== "day" || parsed.address !== address ||
        parsed.period?.slice(0, 7) !== ownerMonth) return sourceIntegrity();
  }
  for (const label of stockTokenTradeHistorySourceResolutionLabels) {
    const expected = `base/${address}/resolution/${label}/${ownerMonth}`;
    if (month.resolutions[label].logicalId !== expected) return sourceIntegrity();
  }
  return month;
};

const validatePositionIdentity = (
  positions: Map<string, string>,
  transactions: Map<string, string>,
  position: Readonly<{
    readonly blockHash: string;
    readonly blockNumber: string;
    readonly transactionHash: string;
    readonly transactionIndex: number;
  }>,
): void => {
  const knownBlock = positions.get(position.blockNumber);
  const knownNumber = positions.get(position.blockHash);
  const coordinate = `${position.blockNumber}:${position.transactionIndex}`;
  const knownTransaction = transactions.get(coordinate);
  const knownCoordinate = transactions.get(position.transactionHash);
  if (knownBlock !== undefined && knownBlock !== position.blockHash ||
      knownNumber !== undefined && knownNumber !== position.blockNumber ||
      knownTransaction !== undefined && knownTransaction !== position.transactionHash ||
      knownCoordinate !== undefined && knownCoordinate !== coordinate) return sourceIntegrity();
  positions.set(position.blockNumber, position.blockHash);
  positions.set(position.blockHash, position.blockNumber);
  transactions.set(coordinate, position.transactionHash);
  transactions.set(position.transactionHash, coordinate);
};

export const parseBaseResolutionFile = (
  value: unknown,
  address: string,
  baseDecimals: number,
  ownerMonth: string,
  label: StockTokenTradeHistorySourceResolutionLabel,
  limits: StockTokenTradeHistorySourceLimits,
): BaseResolutionFile => {
  const coverage = sourceValueCount(value, "coverage");
  const candles = sourceValueCount(value, "candles");
  if (coverage !== undefined && coverage > limits.resolutionCoverageSegments ||
      candles !== undefined && candles > limits.resolutionCandles) {
    throw new StockTokenTradeHistorySourceCapacityError();
  }
  let resolution: BaseResolutionFile;
  try {
    resolution = createSourceFileSchemas(limits).resolution.parse(value) as BaseResolutionFile;
  } catch {
    return sourceIntegrity();
  }
  const definition = stockTokenTradeHistorySourceResolution(label);
  if (resolution.baseCurrencyAddress !== address ||
      !Number.isInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 255 ||
      resolution.ownerMonth !== ownerMonth ||
      resolution.intervalSeconds !== definition.intervalSeconds) return sourceIntegrity();
  validateCoverageSequence(resolution.coverage);
  const monthStart = `${ownerMonth}-01T00:00:00.000Z`;
  const monthEnd = new Date(monthStart);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  const sourceEnd = new Date(
    Math.ceil(monthEnd.getTime() / (definition.intervalSeconds * 1_000)) *
      definition.intervalSeconds * 1_000,
  ).toISOString();
  if (resolution.coverage[0]!.fromTimestamp >= monthEnd.toISOString() ||
      resolution.coverage.some((segment) =>
        segment.fromTimestamp < monthStart || segment.untilTimestamp > sourceEnd)) {
    return sourceIntegrity();
  }
  const blockIdentities = new Map<string, string>();
  const transactionIdentities = new Map<string, string>();
  let previous: BaseResolutionFile["candles"][number] | undefined;
  for (const candle of resolution.candles) {
    const start = Date.parse(candle.intervalStart);
    const end = Date.parse(candle.intervalEnd);
    const observedStart = Date.parse(candle.observedStart);
    const observedEnd = Date.parse(candle.observedEnd);
    const intervalMilliseconds = definition.intervalSeconds * 1_000;
    const spanOrder = comparePositions(candle.firstSource, candle.lastSource);
    const tradeCountValue = BigInt(candle.tradeCount);
    const tradeCountMaximum = BigInt(candle.sourceCandleCount) * maximumMinuteTradeCount;
    const volumeMaximum = tradeCountValue * maximumInt128Magnitude;
    const prices = [candle.open, candle.high, candle.low, candle.close];
    if (
      end - start !== intervalMilliseconds ||
      start % intervalMilliseconds !== 0 ||
      candle.intervalStart.slice(0, 7) !== ownerMonth ||
      observedStart < start || observedStart >= observedEnd || observedEnd > end ||
      compareRationals(candle.high, candle.open) < 0 ||
      compareRationals(candle.high, candle.close) < 0 ||
      compareRationals(candle.low, candle.open) > 0 ||
      compareRationals(candle.low, candle.close) > 0 ||
      compareRationals(candle.high, candle.low) < 0 ||
      candle.sourceCandleCount > definition.intervalSeconds / 60 ||
      candle.sourceCandleCount > (observedEnd - observedStart) / 60_000 ||
      tradeCountValue < BigInt(candle.sourceCandleCount) ||
      tradeCountValue > tradeCountMaximum ||
      BigInt(candle.baseVolumeRaw) < tradeCountValue ||
      BigInt(candle.quoteVolumeRaw) < tradeCountValue ||
      BigInt(candle.baseVolumeRaw) > volumeMaximum ||
      BigInt(candle.quoteVolumeRaw) > volumeMaximum ||
      prices.some((price) => !priceHasAdmittedSwapAmounts(price, baseDecimals)) ||
      spanOrder > 0 ||
      (BigInt(candle.tradeCount) === 1n) !== (spanOrder === 0)
    ) return sourceIntegrity();
    const coverageMatches = resolution.coverage.filter((segment) =>
      segment.fromTimestamp <= candle.intervalStart &&
      segment.untilTimestamp >= candle.intervalEnd &&
      BigInt(segment.fromBlock) <= BigInt(candle.firstSource.blockNumber) &&
      BigInt(segment.untilBlock) > BigInt(candle.lastSource.blockNumber));
    if (coverageMatches.length !== 1) return sourceIntegrity();
    validatePositionIdentity(blockIdentities, transactionIdentities, candle.firstSource);
    validatePositionIdentity(blockIdentities, transactionIdentities, candle.lastSource);
    if (previous !== undefined && (
      candle.intervalStart <= previous.intervalStart ||
      comparePositions(previous.lastSource, candle.firstSource) >= 0 ||
      BigInt(previous.lastSource.blockNumber) >= BigInt(candle.firstSource.blockNumber)
    )) return sourceIntegrity();
    previous = candle;
  }
  return resolution;
};

export const sourceLogicalId = Object.freeze({
  state: (address: string): string => logicalId(address, "state"),
  month: (address: string, month: string): string => logicalId(address, "month", month),
  resolution: (
    address: string,
    label: StockTokenTradeHistorySourceResolutionLabel,
    month: string,
  ): string => `base/${address}/resolution/${label}/${month}`,
});

export const sourceSha256 = (bytes: Uint8Array): string => sha256Bytes(bytes);
