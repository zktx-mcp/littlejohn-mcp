import { z } from "zod";

import {
  canonicalJsonStringify,
  chainAnchorSchema,
  isStrictlyOrderedUnique,
  deepFreezeValue,
  jsonObject,
  maximumTokenDecimals,
  productChainId,
  utcTimestampSchema,
  type CanonicalJson,
  type ChainAnchor,
  type UtcTimestamp,
} from "../core/client.js";
import {
  officialAssetSnapshotEvidenceSchema,
  officialAssetSourceDefinition,
  officialAssetSourceMemberSchema,
  stockFactoryVerificationSchema,
  unavailableStockFactoryResultSchema,
} from "../registry/client.js";
import {
  stockTokenTradeHistoryCanonicalSymbolSchema,
  stockTokenTradeHistoryInputSchema,
  stockTokenTradeHistoryPeriodSchema,
  stockTokenTradeHistoryRequestedStart,
  type StockTokenTradeHistoryInput,
} from "./period-contract.js";
import {
  assertStockTokenTradeHistoryCoveragePoolKeys,
  assertStockTokenTradeHistoryMemberIdentities,
  assertStockTokenTradeHistorySelectedBaseIdentity,
  assertStockTokenTradeHistoryStoredCandleSequence,
  deriveStockTokenTradeHistoryRequestIntervals,
  stockTokenTradeHistoryCoverageSummarySchema,
  stockTokenTradeHistoryPositionLimit,
  stockTokenTradeHistoryPositionSchema,
  stockTokenTradeHistoryPoolIdSchema,
  stockTokenTradeHistoryPoolKeySchema,
  stockTokenTradeHistorySelectedBaseSchema,
  stockTokenTradeHistorySelectedMemberSchema,
  stockTokenTradeHistorySelectedRootSchema,
  stockTokenTradeHistorySourceResolution,
  stockTokenTradeHistorySourceResolutionLabels,
  stockTokenTradeHistorySourceSemanticSchemas,
  stockTokenTradeHistorySourceShapeLimits,
  stockTokenTradeHistoryUnavailableSourceSchema,
} from "./source-semantics.js";

const tokenDecimalsSchema = z.number().int().nonnegative().max(maximumTokenDecimals);

export const stockTokenTradeHistoryOfficialAssetSchema = jsonObject({
  member: officialAssetSourceMemberSchema,
  snapshot: officialAssetSnapshotEvidenceSchema,
}).strict();

const stockTokenTradeHistoryResolutionSchema = jsonObject({
  label: z.enum(stockTokenTradeHistorySourceResolutionLabels),
  intervalSeconds: z.number().int().positive().safe(),
  positionCount: z.number().int().positive().max(stockTokenTradeHistoryPositionLimit),
}).strict().superRefine((value, context) => {
  if (stockTokenTradeHistorySourceResolution(value.label).intervalSeconds !== value.intervalSeconds) {
    context.addIssue({ code: "custom", message: "Trade-history resolution is inconsistent." });
  }
});

const availableDecimalsSchema = jsonObject({
  status: z.literal("available"),
  value: tokenDecimalsSchema,
}).strict();
const unavailableDecimalsSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.literal("call_reverted"),
}).strict();

const requestShape = {
  symbol: stockTokenTradeHistoryCanonicalSymbolSchema,
  period: stockTokenTradeHistoryPeriodSchema,
} as const;
const officialShape = {
  ...requestShape,
  officialAsset: stockTokenTradeHistoryOfficialAssetSchema,
} as const;
const stockFactoryShape = {
  ...officialShape,
  block: chainAnchorSchema,
  stockFactory: stockFactoryVerificationSchema,
} as const;
const archiveRequestShape = {
  ...stockFactoryShape,
  tokenDecimals: availableDecimalsSchema,
  requestedStart: utcTimestampSchema,
  requestedEnd: utcTimestampSchema,
  resolution: stockTokenTradeHistoryResolutionSchema,
} as const;

const officialAssetNotFoundSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.literal("official_asset_not_found"),
  ...requestShape,
  snapshot: officialAssetSnapshotEvidenceSchema,
}).strict();

const officialAssetSymbolAmbiguousSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.literal("official_asset_symbol_ambiguous"),
  ...requestShape,
  snapshot: officialAssetSnapshotEvidenceSchema,
  candidateAssetUids: z.array(officialAssetSourceMemberSchema.shape.assetUid)
    .min(2).max(officialAssetSourceDefinition.memberLimit),
}).strict().superRefine((value, context) => {
  if (
    !isStrictlyOrderedUnique(value.candidateAssetUids)
  ) context.addIssue({ code: "custom", message: "Ambiguous Stock Token identities are invalid." });
});

const stockFactoryUnavailableSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.literal("stock_factory_unavailable"),
  ...officialShape,
  block: chainAnchorSchema,
  stockFactory: unavailableStockFactoryResultSchema,
}).strict();

const tokenDecimalsUnavailableSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.literal("token_decimals_unavailable"),
  ...stockFactoryShape,
  tokenDecimals: unavailableDecimalsSchema,
}).strict();

const stockTokenTradeHistoryArchiveFreshnessStatuses = Object.freeze([
  "unknown",
  "current",
  "stale",
] as const);
type StockTokenTradeHistoryArchiveFreshness =
  (typeof stockTokenTradeHistoryArchiveFreshnessStatuses)[number];
const stockTokenTradeHistoryArchiveFreshnessMilliseconds = 1_800_000 as const;

export function deriveStockTokenTradeHistoryArchiveFreshness(input: Readonly<{
  readonly requestedEnd: UtcTimestamp;
  readonly currentUntil: UtcTimestamp;
}>): "current" | "stale";
export function deriveStockTokenTradeHistoryArchiveFreshness(input: Readonly<{
  readonly requestedEnd: UtcTimestamp;
  readonly currentUntil?: UtcTimestamp;
}>): StockTokenTradeHistoryArchiveFreshness;
export function deriveStockTokenTradeHistoryArchiveFreshness(input: Readonly<{
  readonly requestedEnd: UtcTimestamp;
  readonly currentUntil?: UtcTimestamp;
}>): StockTokenTradeHistoryArchiveFreshness {
  return input.currentUntil === undefined
    ? "unknown"
    : Date.parse(input.requestedEnd) - Date.parse(input.currentUntil) <=
        stockTokenTradeHistoryArchiveFreshnessMilliseconds
      ? "current"
      : "stale";
}

const archiveUnavailableSchema = jsonObject({
  status: z.literal("unavailable"),
  ...archiveRequestShape,
  archive: stockTokenTradeHistoryUnavailableSourceSchema,
  freshness: z.enum(stockTokenTradeHistoryArchiveFreshnessStatuses),
}).strict();

const requestedCoverageSchema = jsonObject({
  status: stockTokenTradeHistoryCoverageSummarySchema.shape.status,
  limitations: stockTokenTradeHistoryCoverageSummarySchema.shape.limitations,
  fromTimestamp: stockTokenTradeHistorySourceSemanticSchemas.wholeSecondTimestamp,
  untilTimestamp: stockTokenTradeHistorySourceSemanticSchemas.wholeSecondTimestamp,
}).strict().superRefine((value, context) => {
  const summary = stockTokenTradeHistoryCoverageSummarySchema.safeParse({
    status: value.status,
    limitations: value.limitations,
  });
  if (!summary.success) {
    context.addIssue({ code: "custom", message: "Trade-history requested coverage is invalid." });
  }
  if (value.fromTimestamp >= value.untilTimestamp) {
    context.addIssue({ code: "custom", message: "Trade-history requested coverage is empty." });
  }
});

const archiveAvailableSchema = jsonObject({
  observedAt: utcTimestampSchema,
  root: stockTokenTradeHistorySelectedRootSchema,
  base: stockTokenTradeHistorySelectedBaseSchema,
  monthMembers: z.array(stockTokenTradeHistorySelectedMemberSchema)
    .min(1).max(stockTokenTradeHistorySourceShapeLimits.stateMonths),
  resolutionMembers: z.array(stockTokenTradeHistorySelectedMemberSchema)
    .max(stockTokenTradeHistorySourceShapeLimits.stateMonths),
  pools: z.record(stockTokenTradeHistoryPoolIdSchema, stockTokenTradeHistoryPoolKeySchema)
    .superRefine((value, context) => {
      if (Object.keys(value).length > stockTokenTradeHistoryPositionLimit) {
        context.addIssue({ code: "custom", message: "Trade-history result Pools exceed positions." });
      }
    }),
}).strict();

const tradeHistoryAvailableSchema = jsonObject({
  status: z.literal("available"),
  ...archiveRequestShape,
  archive: archiveAvailableSchema,
  freshness: z.enum(["current", "stale"]),
  coverage: requestedCoverageSchema,
  positions: z.array(stockTokenTradeHistoryPositionSchema)
    .min(1).max(stockTokenTradeHistoryPositionLimit),
}).strict();

export const stockTokenTradeHistoryDataSchema = z.union([
  officialAssetNotFoundSchema,
  officialAssetSymbolAmbiguousSchema,
  stockFactoryUnavailableSchema,
  tokenDecimalsUnavailableSchema,
  archiveUnavailableSchema,
  tradeHistoryAvailableSchema,
]);
export type StockTokenTradeHistoryData = z.infer<typeof stockTokenTradeHistoryDataSchema>;
export type StockTokenTradeHistoryAvailableData = Extract<
  StockTokenTradeHistoryData,
  { readonly status: "available" }
>;

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJsonStringify(left as CanonicalJson) ===
    canonicalJsonStringify(right as CanonicalJson);

const sameBlock = (left: ChainAnchor, right: ChainAnchor): boolean => sameJson(left, right);

const orderedMemberMonths = (
  members: readonly Readonly<{ readonly ownerMonth: string }>[],
): readonly string[] => {
  const months = members.map((member) => member.ownerMonth);
  if (!isStrictlyOrderedUnique(months)) {
    throw new TypeError("Trade-history member owner months are not ordered and unique.");
  }
  return months;
};

const expectedResolutionOwnerMonths = (
  positions: readonly Readonly<{
    readonly naturalStart: string;
    readonly poolId: string | null;
  }>[],
): readonly string[] => {
  const months: string[] = [];
  for (const position of positions) {
    if (position.poolId === null) continue;
    const month = position.naturalStart.slice(0, 7);
    if (months.at(-1) !== month) months.push(month);
  }
  return months;
};

export const stockTokenTradeHistoryRequestAtBlock = (
  input: StockTokenTradeHistoryInput,
  block: ChainAnchor,
) => {
  const requestedEnd = block.blockTimestamp;
  const requestedStart = stockTokenTradeHistoryRequestedStart(input.period, requestedEnd);
  const request = deriveStockTokenTradeHistoryRequestIntervals({
    requestedStart,
    requestedEnd,
  });
  return deepFreezeValue({
    requestedStart,
    requestedEnd,
    resolution: request.resolution,
  });
};

export const assertStockTokenTradeHistoryIntrinsicData = (
  data: StockTokenTradeHistoryData,
): void => {
  if (!("officialAsset" in data)) return;
  const member = data.officialAsset.member;
  if (data.symbol !== member.sourceSymbol || data.block.chainId !== productChainId) {
    throw new TypeError("Trade-history official identity is inconsistent.");
  }
  if ("reason" in data && data.reason === "stock_factory_unavailable") {
    if (
      data.stockFactory.member.assetUid !== member.assetUid ||
      data.stockFactory.member.contractAddress !== member.contractAddress ||
      data.stockFactory.member.sourceName !== member.sourceName ||
      data.stockFactory.member.sourceSymbol !== member.sourceSymbol
    ) {
      throw new TypeError("Trade-history StockFactory unavailable identity is inconsistent.");
    }
    return;
  }
  if (
    data.stockFactory.assetUid !== member.assetUid ||
    data.stockFactory.contractAddress !== member.contractAddress ||
    !sameBlock(data.block, data.stockFactory.block)
  ) throw new TypeError("Trade-history StockFactory identity is inconsistent.");
  if ("reason" in data && data.reason === "token_decimals_unavailable") return;
  if (!("archive" in data)) throw new TypeError("Trade-history archive stage is missing.");

  if ("status" in data.archive && data.archive.status === "unavailable") {
    if ("base" in data.archive) {
      assertStockTokenTradeHistorySelectedBaseIdentity({
        base: data.archive.base,
        baseCurrencyAddress: member.contractAddress,
        baseCurrencyDecimals: data.tokenDecimals.value,
      });
    }
    const expectedFreshness = deriveStockTokenTradeHistoryArchiveFreshness({
      requestedEnd: data.requestedEnd,
      ...(data.archive.scope === "catalog_root"
        ? {}
        : { currentUntil: data.archive.root.currentUntil.timestamp }),
    });
    if (data.freshness !== expectedFreshness) {
      throw new TypeError("Trade-history unavailable freshness is inconsistent.");
    }
    return;
  }
  if (data.status !== "available") {
    throw new TypeError("Trade-history available stage is inconsistent.");
  }

  assertStockTokenTradeHistorySelectedBaseIdentity({
    base: data.archive.base,
    baseCurrencyAddress: member.contractAddress,
    baseCurrencyDecimals: data.tokenDecimals.value,
  });
  const request = deriveStockTokenTradeHistoryRequestIntervals({
    requestedStart: data.requestedStart,
    requestedEnd: data.requestedEnd,
  });
  if (
    !sameJson(data.resolution, request.resolution) ||
    data.positions.length !== request.positions.length
  ) throw new TypeError("Trade-history public position sequence is inconsistent.");

  if (
    data.coverage.fromTimestamp < data.requestedStart ||
    data.coverage.untilTimestamp > data.requestedEnd ||
    data.coverage.untilTimestamp > data.archive.root.currentUntil.timestamp
  ) throw new TypeError("Trade-history requested coverage exceeds its admitted bounds.");
  const expectedLimitations = [
    ...(data.coverage.fromTimestamp === data.requestedStart
      ? []
      : ["before_published_coverage" as const]),
    ...(data.coverage.untilTimestamp === data.requestedEnd
      ? []
      : ["after_published_coverage" as const]),
  ];
  if (
    !sameJson(data.coverage.limitations, expectedLimitations) ||
    data.coverage.status !== (expectedLimitations.length === 0 ? "complete" : "partial")
  ) throw new TypeError("Trade-history requested coverage meaning is inconsistent.");

  const candles = data.positions.flatMap((position) =>
    position.candle === null ? [] : [position.candle]);
  assertStockTokenTradeHistoryStoredCandleSequence({
    candles,
    baseDecimals: data.tokenDecimals.value,
    resolution: data.resolution.label,
  });
  for (let index = 0; index < data.positions.length; index += 1) {
    const position = data.positions[index]!;
    const expected = request.positions[index]!;
    if (
      position.naturalStart !== expected.naturalStart ||
      position.naturalEnd !== expected.naturalEnd ||
      position.representedStart !== expected.representedStart ||
      position.representedEnd !== expected.representedEnd
    ) throw new TypeError("Trade-history public position bounds are inconsistent.");
    const requestCut = position.representedStart !== position.naturalStart ||
      position.representedEnd !== position.naturalEnd;
    const overlapsCoverage = data.coverage.untilTimestamp > position.representedStart &&
      data.coverage.fromTimestamp < position.representedEnd;
    if (
      (position.coverage === "unavailable") !== !overlapsCoverage ||
      (position.coverage === "complete" && requestCut) ||
      (position.coverage === "complete" && (
        data.coverage.fromTimestamp > position.naturalStart ||
        data.coverage.untilTimestamp < position.naturalEnd
      )) ||
      (position.coverage === "partial" && position.candle !== null && !requestCut)
    ) throw new TypeError("Trade-history public position coverage is inconsistent.");
    if (position.candle !== null && (
      position.candle.intervalStart !== position.naturalStart ||
      position.candle.intervalEnd !== position.naturalEnd ||
      BigInt(position.candle.lastSource.blockNumber) >= BigInt(data.block.blockNumber)
    )) throw new TypeError("Trade-history public candle position is inconsistent.");
  }

  assertStockTokenTradeHistoryCoveragePoolKeys({
    coverage: data.positions.flatMap((position) => position.poolId === null
      ? []
      : [{ poolId: position.poolId }]),
    pools: data.archive.pools,
    baseCurrencyAddress: member.contractAddress,
  });
  const monthOwnerMonths = orderedMemberMonths(data.archive.monthMembers);
  const resolutionOwnerMonths = expectedResolutionOwnerMonths(data.positions);
  if (resolutionOwnerMonths.some((ownerMonth) => !monthOwnerMonths.includes(ownerMonth))) {
    throw new TypeError("Trade-history resolution owner lacks its coverage member.");
  }
  assertStockTokenTradeHistoryMemberIdentities({
    members: data.archive.monthMembers,
    expectedOwnerMonths: monthOwnerMonths,
    baseCurrencyAddress: member.contractAddress,
    kind: "month",
    resolution: data.resolution.label,
  });
  assertStockTokenTradeHistoryMemberIdentities({
    members: data.archive.resolutionMembers,
    expectedOwnerMonths: resolutionOwnerMonths,
    baseCurrencyAddress: member.contractAddress,
    kind: "resolution",
    resolution: data.resolution.label,
  });

  const expectedFreshness = deriveStockTokenTradeHistoryArchiveFreshness({
    requestedEnd: data.requestedEnd,
    currentUntil: data.archive.root.currentUntil.timestamp,
  });
  if (data.freshness !== expectedFreshness) {
    throw new TypeError("Trade-history freshness is inconsistent.");
  }
};

export const assertStockTokenTradeHistoryRequest = (
  inputValue: StockTokenTradeHistoryInput,
  data: StockTokenTradeHistoryData,
): void => {
  const input = stockTokenTradeHistoryInputSchema.parse(inputValue);
  if (
    data.symbol !== input.symbol ||
    !sameJson(data.period, input.period)
  ) throw new TypeError("Trade-history data request identity is inconsistent.");
  if (!("archive" in data)) return;
  const expected = stockTokenTradeHistoryRequestAtBlock(input, data.block);
  if (
    data.requestedStart !== expected.requestedStart ||
    data.requestedEnd !== expected.requestedEnd ||
    !sameJson(data.resolution, expected.resolution)
  ) throw new TypeError("Trade-history request bounds or resolution are inconsistent.");
};

export const assertStockTokenTradeHistoryData = (
  inputValue: StockTokenTradeHistoryInput,
  dataValue: StockTokenTradeHistoryData,
): StockTokenTradeHistoryData => {
  const data = stockTokenTradeHistoryDataSchema.parse(dataValue);
  assertStockTokenTradeHistoryIntrinsicData(data);
  assertStockTokenTradeHistoryRequest(inputValue, data);
  return deepFreezeValue(data);
};

export const assertStockTokenTradeHistoryDataAt = (
  data: StockTokenTradeHistoryData,
  evaluatedAt: UtcTimestamp,
): void => {
  const snapshot = "officialAsset" in data ? data.officialAsset.snapshot : data.snapshot;
  if (
    snapshot.sourceObservedAt > evaluatedAt ||
    ("archive" in data && data.archive.observedAt > evaluatedAt)
  ) {
    throw new TypeError("Trade-history observation exceeds evaluation time.");
  }
};
