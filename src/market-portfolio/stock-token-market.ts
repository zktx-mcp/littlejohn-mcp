import { z, type ZodType } from "zod";

import type { StockTokenChainRead } from "../chain/index.js";
import {
  canonicalJsonStringify,
  canonicalSha256,
  captureCanonicalJson,
  chainAnchorSchema,
  compareCodePointSequences,
  deepFreezeValue,
  exactRationalSchema,
  findStockTokenCatalogDisposition,
  hash32Schema,
  isReferenceObservationFresh,
  jsonObject,
  productChainId,
  productChainNumericId,
  referenceCandleSchema,
  referenceHistoryWindowDefinitions,
  referenceHistoryWindowSchema,
  referenceMarketLimits,
  referenceRoundObservationSchema,
  stockTokenCatalogAssetSchema,
  stockTokenCatalogDispositionSchema,
  stockTokenCatalogEvidence,
  stockTokenCatalogEvidenceSchema,
  stockTokenMarketBaseWarnings,
  stockTokenMarketLimitationCodes,
  stockTokenMarketLimitationCodeSchema,
  stockTokenMarketWarningCodes,
  stockTokenReferenceMarketCatalog,
  utcTimestampSchema,
  type CanonicalJson,
  type ChainAnchor,
  type ReferenceHistoryTraversalReport,
  type ReferenceHistoryWindow,
  type StockTokenCatalogDisposition,
  type StockTokenMarketLimitationCode,
} from "../core/client.js";
import {
  committedOfficialAssetSnapshotSchema,
  officialAssetSnapshotEvidenceSchema,
  officialAssetSourceMemberSchema,
  stockFactoryVerificationResultSchema,
  stockFactoryVerificationSchema,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSnapshotEvidence,
  type OfficialAssetSourceMember,
  type StockFactoryVerification,
} from "../registry/official-asset-contract.js";
import type { ReferenceFeedCacheSnapshot } from "../runtime/reference-market-storage.js";
import {
  createDirectReferenceCandleSeries,
  type ReferenceCandleSeries,
} from "./candles.js";

const canonicalStockTokenSymbolSchema = z.string()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9][A-Z0-9.-]*$/u);
const requestedStockTokenSymbolSchema = z.string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/u)
  .transform((value) => value.toUpperCase())
  .pipe(canonicalStockTokenSymbolSchema);

export const stockTokenMarketInputSchema = jsonObject({
  symbol: requestedStockTokenSymbolSchema,
  window: referenceHistoryWindowSchema.default("1d"),
}).strict();
export type StockTokenMarketInput = z.infer<typeof stockTokenMarketInputSchema>;

export const stockTokenOfficialAssetFactSchema = jsonObject({
  member: officialAssetSourceMemberSchema,
  snapshot: officialAssetSnapshotEvidenceSchema,
}).strict();
export type StockTokenOfficialAssetFact =
  z.infer<typeof stockTokenOfficialAssetFactSchema>;

type MappedStockTokenCatalogDisposition = Extract<
  StockTokenCatalogDisposition,
  { readonly mapping: { readonly status: "mapped" } }
>;
type UnmappedStockTokenCatalogDisposition = Extract<
  StockTokenCatalogDisposition,
  { readonly mapping: { readonly status: "unmapped" } }
>;

export const mappedStockTokenCatalogDispositionSchema =
  stockTokenCatalogDispositionSchema.refine(
    (value): value is MappedStockTokenCatalogDisposition =>
      value.mapping.status === "mapped",
    "Expected a mapped Stock Token catalog disposition.",
  ) as ZodType<MappedStockTokenCatalogDisposition>;
export const unmappedStockTokenCatalogDispositionSchema =
  stockTokenCatalogDispositionSchema.refine(
    (value): value is UnmappedStockTokenCatalogDisposition =>
      value.mapping.status === "unmapped",
    "Expected an unmapped Stock Token catalog disposition.",
  ) as ZodType<UnmappedStockTokenCatalogDisposition>;

export const stockTokenMappingFactSchema = jsonObject({
  catalog: stockTokenCatalogEvidenceSchema,
  disposition: mappedStockTokenCatalogDispositionSchema,
}).strict();
export type StockTokenMappingFact = z.infer<typeof stockTokenMappingFactSchema>;

export const stockTokenOraclePauseObservationSchema = jsonObject({
  tokenAddress: officialAssetSourceMemberSchema.shape.contractAddress,
  value: z.boolean(),
}).strict();
export type StockTokenOraclePauseObservation =
  z.infer<typeof stockTokenOraclePauseObservationSchema>;

const stockTokenPriceCommon = {
  value: exactRationalSchema,
  source: referenceRoundObservationSchema,
} as const;
export const stockTokenPriceSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("current"), ...stockTokenPriceCommon }).strict(),
  jsonObject({ status: z.literal("last_observed"), ...stockTokenPriceCommon }).strict(),
]);
export type StockTokenPrice = z.infer<typeof stockTokenPriceSchema>;

export const stockTokenHistoryCoverageSchema = jsonObject({
  basis: z.literal("observed_rounds"),
  requestedStart: utcTimestampSchema,
  requestedEnd: utcTimestampSchema,
  emptyBucketStarts: z.array(utcTimestampSchema).max(
    referenceHistoryWindowDefinitions["30d"].maximumBuckets,
  ),
}).strict().superRefine((value, context) => {
  const start = Date.parse(value.requestedStart);
  const end = Date.parse(value.requestedEnd);
  if (
    start >= end ||
    new Set(value.emptyBucketStarts).size !== value.emptyBucketStarts.length ||
    value.emptyBucketStarts.some((entry) => {
      const time = Date.parse(entry);
      return time < start || time >= end;
    })
  ) {
    context.addIssue({ code: "custom", message: "Stock Token history coverage is invalid." });
  }
});
export type StockTokenHistoryCoverage = z.infer<typeof stockTokenHistoryCoverageSchema>;

const stockTokenHistoryCommon = {
  coverage: stockTokenHistoryCoverageSchema,
  candles: z.array(referenceCandleSchema).max(
    referenceHistoryWindowDefinitions["30d"].maximumBuckets,
  ),
  sourceObservations: z.array(referenceRoundObservationSchema).max(
    referenceMarketLimits.stockTokenHistorySourceObservations,
  ),
} as const;
export const stockTokenHistorySchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("partial"),
    ...stockTokenHistoryCommon,
    candles: stockTokenHistoryCommon.candles.min(1),
  }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.literal("no_valid_observation"),
    ...stockTokenHistoryCommon,
    candles: stockTokenHistoryCommon.candles.length(0),
    sourceObservations: stockTokenHistoryCommon.sourceObservations.length(0),
  }).strict(),
]);
export type StockTokenHistory = z.infer<typeof stockTokenHistorySchema>;

const stockTokenResultCommon = {
  symbol: canonicalStockTokenSymbolSchema,
  window: referenceHistoryWindowSchema,
} as const;
const unavailableStockFactoryVerificationSchema = stockFactoryVerificationResultSchema.refine(
  (value): value is Extract<typeof value, { readonly status: "unavailable" }> =>
    value.status === "unavailable",
  "Expected an unavailable StockFactory result.",
);

const availableStockTokenMarketResultSchema = jsonObject({
  status: z.literal("available"),
  ...stockTokenResultCommon,
  officialAsset: stockTokenOfficialAssetFactSchema,
  mapping: stockTokenMappingFactSchema,
  block: chainAnchorSchema,
  stockFactory: stockFactoryVerificationSchema,
  oraclePaused: stockTokenOraclePauseObservationSchema,
  price: stockTokenPriceSchema,
  history: stockTokenHistorySchema,
  warnings: z.array(z.enum(stockTokenMarketWarningCodes))
    .min(stockTokenMarketBaseWarnings.length)
    .max(stockTokenMarketWarningCodes.length),
  limitations: z.array(stockTokenMarketLimitationCodeSchema)
    .max(stockTokenMarketLimitationCodes.length),
}).strict();

const unavailableStockTokenMarketResultSchema = z.discriminatedUnion("reason", [
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.literal("official_asset_not_found"),
    ...stockTokenResultCommon,
    snapshot: officialAssetSnapshotEvidenceSchema,
  }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.literal("official_asset_symbol_ambiguous"),
    ...stockTokenResultCommon,
    snapshot: officialAssetSnapshotEvidenceSchema,
    candidateAssetUids: z.array(hash32Schema).min(2).max(512),
  }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.literal("mapping_unavailable"),
    ...stockTokenResultCommon,
    officialAsset: stockTokenOfficialAssetFactSchema,
    catalog: stockTokenCatalogEvidenceSchema,
    disposition: unmappedStockTokenCatalogDispositionSchema,
  }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.literal("mapping_catalog_outdated"),
    ...stockTokenResultCommon,
    officialAsset: stockTokenOfficialAssetFactSchema,
    catalog: stockTokenCatalogEvidenceSchema,
    conflict: z.discriminatedUnion("status", [
      jsonObject({ status: z.literal("uid_absent") }).strict(),
      jsonObject({
        status: z.literal("identity_mismatch"),
        generatedAsset: stockTokenCatalogAssetSchema,
      }).strict(),
    ]),
  }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.literal("stock_factory_unavailable"),
    ...stockTokenResultCommon,
    officialAsset: stockTokenOfficialAssetFactSchema,
    mapping: stockTokenMappingFactSchema,
    block: chainAnchorSchema,
    stockFactory: unavailableStockFactoryVerificationSchema,
  }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.literal("market_observation_unavailable"),
    ...stockTokenResultCommon,
    officialAsset: stockTokenOfficialAssetFactSchema,
    mapping: stockTokenMappingFactSchema,
    block: chainAnchorSchema,
    stockFactory: stockFactoryVerificationSchema,
    oraclePaused: stockTokenOraclePauseObservationSchema,
    observationReason: z.literal("no_valid_observation"),
  }).strict(),
]);

const sameCanonicalValue = (left: unknown, right: unknown): boolean =>
  canonicalJsonStringify(left as CanonicalJson) === canonicalJsonStringify(right as CanonicalJson);
const exactOrderedSubset = <Value>(
  values: readonly Value[],
  ownerOrder: readonly Value[],
): boolean => new Set(values).size === values.length &&
  values.every((value) => ownerOrder.includes(value)) &&
  values.every((value, index) => index === 0 ||
    ownerOrder.indexOf(values[index - 1]!) < ownerOrder.indexOf(value));

const catalogMatches = (catalog: unknown): boolean =>
  canonicalSha256(catalog as CanonicalJson) ===
    canonicalSha256(stockTokenCatalogEvidence as unknown as CanonicalJson);
const officialAssetMatchesDisposition = (
  member: OfficialAssetSourceMember,
  disposition: StockTokenCatalogDisposition,
): boolean => {
  const chainDeployments = disposition.asset.deployments.filter((deployment) =>
    deployment.chainId === productChainNumericId);
  return disposition.asset.assetUid === member.assetUid &&
    disposition.asset.symbol === member.sourceSymbol &&
    chainDeployments.length === 1 &&
    chainDeployments[0]!.contractAddress === member.contractAddress &&
    (disposition.mapping.status !== "mapped" ||
      disposition.mapping.selectedDeployment.contractAddress === member.contractAddress);
};
const isExactCatalogDisposition = (
  disposition: StockTokenCatalogDisposition,
): boolean => {
  const current = findStockTokenCatalogDisposition(disposition.asset.assetUid);
  return current !== undefined && sameCanonicalValue(current, disposition);
};

const validateAvailableResult = (
  value: z.infer<typeof availableStockTokenMarketResultSchema>,
  context: z.core.$RefinementCtx,
): void => {
  const disposition = value.mapping.disposition;
  const member = value.officialAsset.member;
  const feedId = disposition.mapping.feed.feedId;
  const source = value.price.source;
  const sourceIsFresh = isReferenceObservationFresh(source, value.block.blockTimestamp);
  const expectedPriceStatus = !value.oraclePaused.value && sourceIsFresh
    ? "current"
    : "last_observed";
  const expectedObservableLimitations = [
    ...(value.oraclePaused.value ? ["oracle_paused" as const] : []),
    ...(!sourceIsFresh ? ["observation_not_fresh" as const] : []),
  ];
  const expectedPartialWarning = value.history.status === "partial";
  const expectedWarnings = [
    ...stockTokenMarketBaseWarnings,
    ...(expectedPartialWarning ? ["partial_history" as const] : []),
  ];
  const maximumCandles = referenceHistoryWindowDefinitions[value.window].maximumBuckets;
  const candleFeedIds = value.history.candles.flatMap((candle) => [
    ...candle.openSourcePointers,
    ...candle.highSourcePointers,
    ...candle.lowSourcePointers,
    ...candle.closeSourcePointers,
  ]).map((pointer) => pointer.feedId);
  const interval = stockTokenHistoryInterval(value.window, value.block.blockTimestamp);
  const expectedSeries = createDirectReferenceCandleSeries({
    feedId,
    window: value.window,
    block: value.block,
    snapshot: {
      feedId,
      revision: null,
      observations: value.history.sourceObservations,
      backfillPhaseId: null,
      backfillNextRoundId: null,
      retentionCutoffRoundId: null,
      integrityStatus: null,
      backfillStatus: null,
    },
  });
  if (
    value.symbol !== member.sourceSymbol ||
    !isExactCatalogDisposition(disposition) ||
    !officialAssetMatchesDisposition(member, disposition) ||
    !catalogMatches(value.mapping.catalog) ||
    value.block.chainId !== productChainId ||
    value.block.chainId !== value.stockFactory.block.chainId ||
    canonicalSha256(value.block) !== canonicalSha256(value.stockFactory.block) ||
    value.stockFactory.assetUid !== member.assetUid ||
    value.stockFactory.contractAddress !== member.contractAddress ||
    value.oraclePaused.tokenAddress !== member.contractAddress ||
    source.fact.feedId !== feedId ||
    canonicalSha256(source.readEvidence.block) !== canonicalSha256(value.block) ||
    value.price.status !== expectedPriceStatus ||
    !sameCanonicalValue(value.price.value, source.fact.value) ||
    value.history.candles.length > maximumCandles ||
    value.history.coverage.requestedStart !== interval.requestedStart ||
    value.history.coverage.requestedEnd !== interval.requestedEnd ||
    value.history.sourceObservations.some((observation) =>
      observation.fact.feedId !== feedId) ||
    !sameCanonicalValue(value.history.coverage, expectedSeries.coverage) ||
    !sameCanonicalValue(value.history.candles, expectedSeries.candles) ||
    !sameCanonicalValue(value.history.sourceObservations, expectedSeries.sourceObservations) ||
    candleFeedIds.some((candidate) => candidate !== feedId) ||
    !exactOrderedSubset(value.limitations, stockTokenMarketLimitationCodes) ||
    !value.limitations.includes("source_history_not_exhaustive") ||
    expectedObservableLimitations.some((limitation) => !value.limitations.includes(limitation)) ||
    value.limitations.includes("oracle_paused") !== value.oraclePaused.value ||
    value.limitations.includes("observation_not_fresh") !== !sourceIsFresh ||
    value.limitations.includes("empty_history") !== (value.history.status === "unavailable") ||
    !sameCanonicalValue(value.warnings, expectedWarnings)
  ) {
    context.addIssue({ code: "custom", message: "Stock Token market result is inconsistent." });
  }
};

const validateUnavailableResult = (
  value: z.infer<typeof unavailableStockTokenMarketResultSchema>,
  context: z.core.$RefinementCtx,
): void => {
  if (value.reason === "official_asset_symbol_ambiguous") {
    if (
      new Set(value.candidateAssetUids).size !== value.candidateAssetUids.length ||
      value.candidateAssetUids.some((assetUid, index) => index > 0 &&
        compareCodePointSequences(value.candidateAssetUids[index - 1]!, assetUid) >= 0)
    ) context.addIssue({ code: "custom", message: "Ambiguous asset identities are invalid." });
    return;
  }
  if (value.reason === "official_asset_not_found") return;
  if (!catalogMatches(value.reason === "mapping_unavailable" ||
    value.reason === "mapping_catalog_outdated" ? value.catalog : value.mapping.catalog)) {
    context.addIssue({ code: "custom", message: "Stock Token catalog evidence is invalid." });
    return;
  }
  const member = value.officialAsset.member;
  if (value.symbol !== member.sourceSymbol) {
    context.addIssue({ code: "custom", message: "Stock Token selector is inconsistent." });
    return;
  }
  if (value.reason === "mapping_unavailable") {
    if (
      !isExactCatalogDisposition(value.disposition) ||
      !officialAssetMatchesDisposition(member, value.disposition)
    ) {
      context.addIssue({ code: "custom", message: "Stock Token unavailable mapping is inconsistent." });
    }
    return;
  }
  if (value.reason === "mapping_catalog_outdated") {
    const current = findStockTokenCatalogDisposition(member.assetUid);
    if (
      (value.conflict.status === "uid_absent" && current !== undefined) ||
      (value.conflict.status === "identity_mismatch" &&
        (current === undefined ||
          sameCanonicalValue(current.asset, value.conflict.generatedAsset) === false ||
          officialAssetMatchesDisposition(member, current)))
    ) context.addIssue({ code: "custom", message: "Stock Token mapping conflict is invalid." });
    return;
  }
  const disposition = value.mapping.disposition;
  if (
    !isExactCatalogDisposition(disposition) ||
    !officialAssetMatchesDisposition(member, disposition) ||
    value.block.chainId !== productChainId
  ) {
    context.addIssue({ code: "custom", message: "Stock Token unavailable result is inconsistent." });
    return;
  }
  if (value.reason === "stock_factory_unavailable") {
    if (!sameCanonicalValue(value.stockFactory.member, member)) {
      context.addIssue({ code: "custom", message: "StockFactory unavailable member is inconsistent." });
    }
    return;
  }
  if (
    value.stockFactory.assetUid !== member.assetUid ||
    value.stockFactory.contractAddress !== member.contractAddress ||
    canonicalSha256(value.stockFactory.block) !== canonicalSha256(value.block) ||
    value.oraclePaused.tokenAddress !== member.contractAddress
  ) context.addIssue({ code: "custom", message: "Stock Token observation failure is inconsistent." });
};

export const stockTokenMarketResultSchema = z.union([
  availableStockTokenMarketResultSchema.superRefine(validateAvailableResult),
  unavailableStockTokenMarketResultSchema.superRefine(validateUnavailableResult),
]);
export type StockTokenMarketResult = z.infer<typeof stockTokenMarketResultSchema>;

const snapshotEvidence = (
  snapshotInput: CommittedOfficialAssetSnapshot,
): OfficialAssetSnapshotEvidence => {
  const snapshot = committedOfficialAssetSnapshotSchema.parse(snapshotInput);
  return deepFreezeValue(officialAssetSnapshotEvidenceSchema.parse({
    sourceUri: snapshot.sourceUri,
    sourceObservedAt: snapshot.sourceObservedAt,
    rawResponseDigest: snapshot.rawResponseDigest,
    memberSetDigest: snapshot.memberSetDigest,
    revision: snapshot.revision,
  }));
};

export type StockTokenMarketAssetResolution =
  | Readonly<{
      status: "mapped";
      officialAsset: StockTokenOfficialAssetFact;
      mapping: StockTokenMappingFact;
    }>
  | Extract<StockTokenMarketResult, {
      readonly status: "unavailable";
      readonly reason:
        | "official_asset_not_found"
        | "official_asset_symbol_ambiguous"
        | "mapping_unavailable"
        | "mapping_catalog_outdated";
    }>;

export type MappedStockTokenMarketAssetResolution = Extract<
  StockTokenMarketAssetResolution,
  { readonly status: "mapped" }
>;

export const resolveStockTokenMarketAsset = (
  inputValue: unknown,
  snapshotInput: CommittedOfficialAssetSnapshot,
): StockTokenMarketAssetResolution => {
  const input = stockTokenMarketInputSchema.parse(captureCanonicalJson(inputValue));
  const snapshot = committedOfficialAssetSnapshotSchema.parse(snapshotInput);
  const evidence = snapshotEvidence(snapshot);
  const candidates = snapshot.members.filter((member) => member.sourceSymbol === input.symbol);
  if (candidates.length === 0) {
    return deepFreezeValue({
      status: "unavailable",
      reason: "official_asset_not_found",
      symbol: input.symbol,
      window: input.window,
      snapshot: evidence,
    });
  }
  if (candidates.length > 1) {
    return deepFreezeValue({
      status: "unavailable",
      reason: "official_asset_symbol_ambiguous",
      symbol: input.symbol,
      window: input.window,
      snapshot: evidence,
      candidateAssetUids: candidates.map((member) => member.assetUid)
        .sort(compareCodePointSequences),
    });
  }
  const member = candidates[0]!;
  const officialAsset = deepFreezeValue({ member, snapshot: evidence });
  const disposition = findStockTokenCatalogDisposition(member.assetUid);
  if (disposition === undefined) {
    return deepFreezeValue({
      status: "unavailable",
      reason: "mapping_catalog_outdated",
      symbol: input.symbol,
      window: input.window,
      officialAsset,
      catalog: stockTokenCatalogEvidence,
      conflict: { status: "uid_absent" },
    });
  }
  if (!officialAssetMatchesDisposition(member, disposition)) {
    return deepFreezeValue({
      status: "unavailable",
      reason: "mapping_catalog_outdated",
      symbol: input.symbol,
      window: input.window,
      officialAsset,
      catalog: stockTokenCatalogEvidence,
      conflict: { status: "identity_mismatch", generatedAsset: disposition.asset },
    });
  }
  if (disposition.mapping.status === "unmapped") {
    const unavailableDisposition =
      unmappedStockTokenCatalogDispositionSchema.parse(disposition);
    return deepFreezeValue({
      status: "unavailable",
      reason: "mapping_unavailable",
      symbol: input.symbol,
      window: input.window,
      officialAsset,
      catalog: stockTokenCatalogEvidence,
      disposition: unavailableDisposition,
    });
  }
  const mappedDisposition = mappedStockTokenCatalogDispositionSchema.parse(disposition);
  return deepFreezeValue({
    status: "mapped",
    officialAsset,
    mapping: { catalog: stockTokenCatalogEvidence, disposition: mappedDisposition },
  });
};

export const createStockTokenMarketUnavailableAfterChainRead = (input: Readonly<{
  request: StockTokenMarketInput;
  resolution: MappedStockTokenMarketAssetResolution;
  block: ChainAnchor;
  read: Exclude<StockTokenChainRead, { readonly status: "observed" }>;
}>): StockTokenMarketResult => {
  const common = {
    status: "unavailable" as const,
    symbol: input.request.symbol,
    window: input.request.window,
    officialAsset: input.resolution.officialAsset,
    mapping: input.resolution.mapping,
    block: input.block,
    stockFactory: input.read.stockFactory,
  };
  return parseStockTokenMarketResult(input.request, input.read.status === "stock_factory_unavailable"
    ? {
        ...common,
        reason: "stock_factory_unavailable",
      }
    : {
        ...common,
        reason: "market_observation_unavailable",
        oraclePaused: {
          tokenAddress: input.resolution.officialAsset.member.contractAddress,
          value: input.read.oraclePaused,
        },
        observationReason: "no_valid_observation",
      });
};

export const createAvailableStockTokenMarketResult = (input: Readonly<{
  request: StockTokenMarketInput;
  resolution: MappedStockTokenMarketAssetResolution;
  block: ChainAnchor;
  read: Extract<StockTokenChainRead, { readonly status: "observed" }>;
  series: ReferenceCandleSeries;
  snapshot: ReferenceFeedCacheSnapshot;
  report: ReferenceHistoryTraversalReport;
}>): StockTokenMarketResult => {
  const sourceIsFresh = isReferenceObservationFresh(
    input.read.latest,
    input.block.blockTimestamp,
  );
  const historyAvailable = input.series.candles.length > 0;
  const limitationSet = new Set<StockTokenMarketLimitationCode>([
    "source_history_not_exhaustive",
    ...(input.read.oraclePaused ? ["oracle_paused" as const] : []),
    ...(!sourceIsFresh ? ["observation_not_fresh" as const] : []),
    ...(input.report.remainingContinuation ? ["remaining_continuation" as const] : []),
    ...(input.report.remainingGap ? ["remaining_gap" as const] : []),
    ...(input.report.phaseBoundaryObserved ? ["phase_boundary" as const] : []),
    ...(input.report.malformedRoundObserved ? ["malformed_round" as const] : []),
    ...(input.snapshot.retentionCutoffRoundId !== null ? ["retention_boundary" as const] : []),
    ...(!historyAvailable ? ["empty_history" as const] : []),
  ]);
  const limitations = stockTokenMarketLimitationCodes.filter((code) => limitationSet.has(code));
  return parseStockTokenMarketResult(input.request, {
    status: "available",
    symbol: input.request.symbol,
    window: input.request.window,
    officialAsset: input.resolution.officialAsset,
    mapping: input.resolution.mapping,
    block: input.block,
    stockFactory: input.read.stockFactory as StockFactoryVerification,
    oraclePaused: {
      tokenAddress: input.resolution.officialAsset.member.contractAddress,
      value: input.read.oraclePaused,
    },
    price: {
      status: !input.read.oraclePaused && sourceIsFresh ? "current" : "last_observed",
      value: input.read.latest.fact.value,
      source: input.read.latest,
    },
    history: historyAvailable
      ? {
          status: "partial",
          coverage: input.series.coverage,
          candles: input.series.candles,
          sourceObservations: input.series.sourceObservations,
        }
      : {
          status: "unavailable",
          reason: "no_valid_observation",
          coverage: input.series.coverage,
          candles: [],
          sourceObservations: [],
        },
    warnings: [
      ...stockTokenMarketBaseWarnings,
      ...(historyAvailable ? ["partial_history" as const] : []),
    ],
    limitations,
  });
};

export const parseStockTokenMarketResult = (
  inputValue: unknown,
  resultValue: unknown,
): StockTokenMarketResult => {
  const input = stockTokenMarketInputSchema.parse(captureCanonicalJson(inputValue));
  const result = stockTokenMarketResultSchema.parse(captureCanonicalJson(resultValue));
  if (result.symbol !== input.symbol || result.window !== input.window) {
    throw new TypeError("Stock Token market result does not match its request.");
  }
  return deepFreezeValue(result);
};

export const stockTokenHistoryInterval = (
  window: ReferenceHistoryWindow,
  blockTimestamp: string,
): Readonly<{ requestedStart: string; requestedEnd: string }> => {
  const requestedEnd = Date.parse(blockTimestamp);
  return Object.freeze({
    requestedStart: new Date(
      requestedEnd - referenceHistoryWindowDefinitions[window].windowMilliseconds,
    ).toISOString(),
    requestedEnd: new Date(requestedEnd).toISOString(),
  });
};
