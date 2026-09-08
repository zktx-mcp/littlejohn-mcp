import { gunzipSync } from "node:zlib";

import { z } from "zod";

import {
  evmAddressSchema,
  isStrictlyOrderedUnique,
  jsonObject,
  sha256Bytes,
} from "../core/index.js";
import {
  stockTokenTradeHistoryProducerAdmission,
  type StockTokenTradeHistorySourceLimits,
} from "./source-contract.js";
import {
  assertStockTokenTradeHistoryPoolIdentity,
  assertStockTokenTradeHistoryStoredCandleSequence,
  parseStockTokenTradeHistoryMemberLogicalId,
  stockTokenTradeHistoryBaseDecimalsSchema,
  stockTokenTradeHistoryCollectionBoundarySchema,
  stockTokenTradeHistoryCoverageSegmentSchema,
  stockTokenTradeHistoryInitializeBoundarySchema,
  stockTokenTradeHistoryLogicalId,
  stockTokenTradeHistoryPoolIdSchema,
  stockTokenTradeHistoryPoolKeySchema,
  stockTokenTradeHistorySourceIdentity,
  stockTokenTradeHistorySourceResolution,
  stockTokenTradeHistorySourceResolutionLabels,
  stockTokenTradeHistorySourceSemanticSchemas,
  stockTokenTradeHistoryStoredCandleSchema,
  stockTokenTradeHistoryStoredMemberIdentityShape,
  type StockTokenTradeHistoryCoverageSegment,
  type StockTokenTradeHistoryCollectionBoundary,
  type StockTokenTradeHistoryInitializeBoundary,
  type StockTokenTradeHistoryPoolKey,
  type StockTokenTradeHistorySelectedRoot,
  type StockTokenTradeHistorySourceResolution,
  type StockTokenTradeHistorySourceResolutionLabel,
  type StockTokenTradeHistoryStoredCandle,
} from "./source-semantics.js";

const {
  hexSha256,
  nonnegativeSafeInteger,
  positiveSafeInteger,
  utcMonth,
} = stockTokenTradeHistorySourceSemanticSchemas;

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

const parseSourceFileLogicalId = (value: string): Readonly<{
  readonly address: string;
  readonly kind: "state" | "month" | "day" | "resolution";
  readonly period?: string;
  readonly resolution?: StockTokenTradeHistorySourceResolutionLabel;
}> | undefined => {
  const member = parseStockTokenTradeHistoryMemberLogicalId(value);
  if (member !== undefined) return member;
  const day = value.match(
    /^base\/(0x[0-9a-f]{40})\/day\/((?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01]))$/u,
  );
  if (day === null) return undefined;
  const date = new Date(`${day[2]}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day[2]
    ? Object.freeze({ address: day[1]!, kind: "day", period: day[2]! })
    : undefined;
};

const assertSourceSemantics = (assertion: () => void): void => {
  try {
    assertion();
  } catch (error) {
    if (error instanceof TypeError || error instanceof z.ZodError) sourceIntegrity();
    throw error;
  }
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
  readonly usdgDecimals: StockTokenTradeHistorySelectedRoot["usdgDecimals"];
}

export interface BaseStateFile {
  readonly baseCurrencyAddress: string;
  readonly decimals: number;
  readonly months: readonly StoredMemberReference[];
  readonly poolPeriods: readonly StockTokenTradeHistoryCoverageSegment[];
  readonly pools: Readonly<Record<string, SourcePoolFacts>>;
}

export interface SourcePoolFacts {
  readonly historyFrom: StockTokenTradeHistoryCollectionBoundary;
  readonly sourceFrom: StockTokenTradeHistoryCollectionBoundary;
  readonly initialize: StockTokenTradeHistoryInitializeBoundary;
  readonly poolKey: StockTokenTradeHistoryPoolKey;
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
  readonly candles: readonly StockTokenTradeHistoryStoredCandle[];
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

const sourceNestedArrayCount = (
  value: unknown,
  collectionKey: string,
  memberKey: string,
): number | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const collection = (value as Readonly<Record<string, unknown>>)[collectionKey];
  if (!Array.isArray(collection)) return undefined;
  let total = 0;
  for (const item of collection) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const member = (item as Readonly<Record<string, unknown>>)[memberKey];
    if (!Array.isArray(member)) continue;
    total += member.length;
    if (!Number.isSafeInteger(total)) return Number.POSITIVE_INFINITY;
  }
  return total;
};

const storedMemberReferenceSchema = jsonObject({
  ...stockTokenTradeHistoryStoredMemberIdentityShape,
  from: nonnegativeSafeInteger,
  jsonBytes: positiveSafeInteger,
  until: positiveSafeInteger,
}).strict().superRefine((value, context) => {
  if (value.from >= value.until || parseSourceFileLogicalId(value.logicalId) === undefined) {
    context.addIssue({ code: "custom", message: "Stored member reference is invalid." });
  }
});

const selectedAssetEntrySchema = jsonObject({
  assetName: z.string().min(1).max(256),
  bytes: positiveSafeInteger.max(stockTokenTradeHistoryProducerAdmission.maximumPhysicalAssetBytes),
  logicalIds: z.array(z.string().min(1).max(128)).min(1),
  releaseTag: z.string().min(1).max(256),
  sha256: hexSha256,
}).strict();

const sourceResolutionEntrySchema = jsonObject({
  label: z.string().min(1).max(4),
  intervalSeconds: positiveSafeInteger,
  partition: z.enum(["day", "month"]),
}).strict();

const selectedRootFileSchema = jsonObject({
  assets: z.array(selectedAssetEntrySchema).min(1),
  baseCurrencies: z.record(evmAddressSchema, storedMemberReferenceSchema),
  currentUntil: stockTokenTradeHistoryCollectionBoundarySchema,
  poolManager: z.literal(stockTokenTradeHistorySourceIdentity.poolManager),
  publicationSequence: positiveSafeInteger,
  resolutions: z.array(sourceResolutionEntrySchema)
    .length(stockTokenTradeHistorySourceIdentity.resolutions.length),
  usdgAddress: z.literal(stockTokenTradeHistorySourceIdentity.usdgAddress),
  usdgDecimals: z.literal(stockTokenTradeHistorySourceIdentity.usdgDecimals),
}).strict();

const sourcePoolFactsSchema = jsonObject({
  historyFrom: stockTokenTradeHistoryCollectionBoundarySchema,
  sourceFrom: stockTokenTradeHistoryCollectionBoundarySchema,
  initialize: stockTokenTradeHistoryInitializeBoundarySchema,
  poolKey: stockTokenTradeHistoryPoolKeySchema,
}).strict();

const baseStateFileSchema = jsonObject({
  baseCurrencyAddress: evmAddressSchema,
  decimals: stockTokenTradeHistoryBaseDecimalsSchema,
  months: z.array(storedMemberReferenceSchema).min(1),
  poolPeriods: z.array(stockTokenTradeHistoryCoverageSegmentSchema).min(1),
  pools: z.record(stockTokenTradeHistoryPoolIdSchema, sourcePoolFactsSchema),
}).strict();

const monthResolutionsSchema = jsonObject(Object.fromEntries(
  stockTokenTradeHistorySourceResolutionLabels.map((label) => [label, storedMemberReferenceSchema]),
) as Record<StockTokenTradeHistorySourceResolutionLabel, typeof storedMemberReferenceSchema>).strict();

const baseMonthFileSchema = jsonObject({
  baseCurrencyAddress: evmAddressSchema,
  coverage: z.array(stockTokenTradeHistoryCoverageSegmentSchema).min(1),
  days: z.array(storedMemberReferenceSchema).min(1),
  month: utcMonth,
  resolutions: monthResolutionsSchema,
}).strict();

const baseResolutionFileSchema = jsonObject({
  baseCurrencyAddress: evmAddressSchema,
  candles: z.array(stockTokenTradeHistoryStoredCandleSchema),
  coverage: z.array(stockTokenTradeHistoryCoverageSegmentSchema).min(1),
  intervalSeconds: positiveSafeInteger,
  ownerMonth: utcMonth,
}).strict();

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
      !isStrictlyOrderedUnique(entry.logicalIds)) return sourceIntegrity();
  const kinds = new Set<string>();
  for (const id of entry.logicalIds) {
    const parsed = parseSourceFileLogicalId(id);
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
  const assets = sourceValueCount(value, "assets");
  const baseCurrencies = sourceValueCount(value, "baseCurrencies");
  const logicalIds = sourceNestedArrayCount(value, "assets", "logicalIds");
  if (assets !== undefined && assets > limits.rootAssets ||
      baseCurrencies !== undefined && baseCurrencies > limits.rootBaseCurrencies ||
      logicalIds !== undefined && logicalIds > limits.rootLogicalIds) {
    throw new StockTokenTradeHistorySourceCapacityError();
  }
  let root: SelectedRootFile;
  try {
    root = selectedRootFileSchema.parse(value) as SelectedRootFile;
  } catch {
    return sourceIntegrity();
  }
  if (canonicalJson(root.resolutions) !== canonicalJson(stockTokenTradeHistorySourceIdentity.resolutions)) {
    return sourceIntegrity();
  }
  if (Object.keys(root.baseCurrencies).length === 0) return sourceIntegrity();
  const assetDigests = root.assets.map((entry) => entry.sha256);
  if (!isStrictlyOrderedUnique(assetDigests)) return sourceIntegrity();
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
    if (reference.logicalId !== stockTokenTradeHistoryLogicalId.state(address) ||
        selectedAsset?.sha256 !== reference.assetSha256 ||
        reference.until > (selectedAsset?.bytes ?? 0)) return sourceIntegrity();
  }
  return root;
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
    state = baseStateFileSchema.parse(value) as BaseStateFile;
  } catch {
    return sourceIntegrity();
  }
  if (state.baseCurrencyAddress !== address || state.decimals !== decimals) return sourceIntegrity();
  if (Object.keys(state.pools).length === 0) return sourceIntegrity();
  validateCoverageSequence(state.poolPeriods);
  for (const [poolId, facts] of Object.entries(state.pools)) {
    assertSourceSemantics(() => assertStockTokenTradeHistoryPoolIdentity({
      poolId,
      baseCurrencyAddress: address,
      poolKey: facts.poolKey,
    }));
    const owned = state.poolPeriods.filter((period) => period.poolId === poolId);
    if (owned.length === 0 ||
        owned[0]!.fromBlock !== facts.historyFrom.blockNumber ||
        owned[0]!.fromTimestamp !== facts.historyFrom.timestamp) return sourceIntegrity();
  }
  if (state.poolPeriods.some((period) => state.pools[period.poolId] === undefined)) {
    return sourceIntegrity();
  }
  const monthIds = state.months.map((reference) => reference.logicalId);
  if (!isStrictlyOrderedUnique(monthIds)) return sourceIntegrity();
  for (const reference of state.months) {
    const parsed = parseStockTokenTradeHistoryMemberLogicalId(reference.logicalId);
    if (parsed?.kind !== "month" || parsed.address !== address ||
        reference.logicalId !== stockTokenTradeHistoryLogicalId.month(address, parsed.period!)) {
      return sourceIntegrity();
    }
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
    month = baseMonthFileSchema.parse(value) as BaseMonthFile;
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
  if (!isStrictlyOrderedUnique(dayIds)) return sourceIntegrity();
  for (const reference of month.days) {
    const parsed = parseSourceFileLogicalId(reference.logicalId);
    if (parsed?.kind !== "day" || parsed.address !== address ||
        parsed.period?.slice(0, 7) !== ownerMonth) return sourceIntegrity();
  }
  for (const label of stockTokenTradeHistorySourceResolutionLabels) {
    const expected = stockTokenTradeHistoryLogicalId.resolution(address, label, ownerMonth);
    if (month.resolutions[label].logicalId !== expected) return sourceIntegrity();
  }
  return month;
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
    resolution = baseResolutionFileSchema.parse(value) as BaseResolutionFile;
  } catch {
    return sourceIntegrity();
  }
  const definition = stockTokenTradeHistorySourceResolution(label);
  if (resolution.baseCurrencyAddress !== address ||
      !stockTokenTradeHistoryBaseDecimalsSchema.safeParse(baseDecimals).success ||
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
  assertSourceSemantics(() => assertStockTokenTradeHistoryStoredCandleSequence({
    candles: resolution.candles,
    baseDecimals,
    resolution: label,
    ownerMonth,
  }));
  for (const candle of resolution.candles) {
    const coverageMatches = resolution.coverage.filter((segment) =>
      segment.fromTimestamp <= candle.intervalStart &&
      segment.untilTimestamp >= candle.intervalEnd &&
      BigInt(segment.fromBlock) <= BigInt(candle.firstSource.blockNumber) &&
      BigInt(segment.untilBlock) > BigInt(candle.lastSource.blockNumber));
    if (coverageMatches.length !== 1) return sourceIntegrity();
  }
  return resolution;
};

export const sourceSha256 = (bytes: Uint8Array): string => sha256Bytes(bytes);
