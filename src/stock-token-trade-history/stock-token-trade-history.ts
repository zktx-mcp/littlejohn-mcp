import { z } from "zod";

import {
  canonicalSha256,
  captureCanonicalJson,
  chainAnchorSchema,
  compareCodePointSequences,
  deepFreezeValue,
  jsonObject,
  marketTimeWindowDefinitions,
  marketTimeWindowSchema,
  productChainId,
  type ChainAnchor,
  type MarketTimeWindow,
} from "../core/client.js";
import {
  committedOfficialAssetSnapshotSchema,
  officialAssetSnapshotEvidenceSchema,
  officialAssetSourceMemberSchema,
  stockFactoryVerificationSchema,
  unavailableStockFactoryResultSchema,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSnapshotEvidence,
  type StockFactoryVerification,
} from "../registry/client.js";
import {
  findStockTokenTradeHistoryAsset,
  stockTokenTradeHistoryDataAvailableFields,
  stockTokenTradeHistoryDataAvailableSchema,
  stockTokenTradeHistoryDataUnavailableFields,
  stockTokenTradeHistoryDataUnavailableSchema,
  type StockTokenTradeHistoryData,
} from "./stock-token-trade-history-data.js";

const canonicalStockTokenSymbolSchema = z.string()
  .min(1).max(32).regex(/^[A-Z0-9][A-Z0-9.-]*$/u);
const requestedStockTokenSymbolSchema = z.string()
  .min(1).max(32).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/u)
  .transform((value) => value.toUpperCase())
  .pipe(canonicalStockTokenSymbolSchema);

export const stockTokenTradeHistoryInputSchema = jsonObject({
  symbol: requestedStockTokenSymbolSchema,
  window: marketTimeWindowSchema.default("1d"),
}).strict();
export type StockTokenTradeHistoryInput = z.infer<typeof stockTokenTradeHistoryInputSchema>;

export const stockTokenTradeHistoryOfficialAssetSchema = jsonObject({
  member: officialAssetSourceMemberSchema,
  snapshot: officialAssetSnapshotEvidenceSchema,
}).strict();
export type StockTokenTradeHistoryOfficialAsset = z.infer<
  typeof stockTokenTradeHistoryOfficialAssetSchema
>;

const requestIdentityShape = {
  symbol: canonicalStockTokenSymbolSchema,
  window: marketTimeWindowSchema,
} as const;
const verifiedIdentityShape = {
  ...requestIdentityShape,
  officialAsset: stockTokenTradeHistoryOfficialAssetSchema,
  block: chainAnchorSchema,
  stockFactory: stockFactoryVerificationSchema,
} as const;

const officialAssetNotFoundSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.literal("official_asset_not_found"),
  ...requestIdentityShape,
  snapshot: officialAssetSnapshotEvidenceSchema,
}).strict();

const officialAssetSymbolAmbiguousSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.literal("official_asset_symbol_ambiguous"),
  ...requestIdentityShape,
  snapshot: officialAssetSnapshotEvidenceSchema,
  candidateAssetUids: z.array(officialAssetSourceMemberSchema.shape.assetUid).min(2),
}).strict();

const stockFactoryUnavailableSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.literal("stock_factory_unavailable"),
  ...requestIdentityShape,
  officialAsset: stockTokenTradeHistoryOfficialAssetSchema,
  block: chainAnchorSchema,
  stockFactory: unavailableStockFactoryResultSchema,
}).strict();

const tradeHistoryUnavailableSchema = jsonObject({
  status: z.literal("unavailable"),
  ...verifiedIdentityShape,
  ...stockTokenTradeHistoryDataUnavailableFields,
}).strict();

const tradeHistoryAvailableSchema = jsonObject({
  status: z.literal("available"),
  ...verifiedIdentityShape,
  ...stockTokenTradeHistoryDataAvailableFields,
}).strict();

const sameBlock = (left: ChainAnchor, right: ChainAnchor): boolean =>
  canonicalSha256(left) === canonicalSha256(right);

const validateVerifiedIdentity = (
  value: z.infer<typeof tradeHistoryAvailableSchema> | z.infer<typeof tradeHistoryUnavailableSchema>,
  context: z.RefinementCtx,
): void => {
  const member = value.officialAsset.member;
  const interval = stockTokenTradeHistoryInterval(value.window, value.block.blockTimestamp);
  if (
    value.symbol !== member.sourceSymbol ||
    value.block.chainId !== productChainId ||
    value.stockFactory.assetUid !== member.assetUid ||
    value.stockFactory.contractAddress !== member.contractAddress ||
    !sameBlock(value.block, value.stockFactory.block) ||
    value.requestedStart !== interval.requestedStart ||
    value.requestedEnd !== interval.requestedEnd
  ) {
    context.addIssue({ code: "custom", message: "Stock Token trade-history identity is inconsistent." });
  }
};

const validatedTradeHistoryAvailableSchema = tradeHistoryAvailableSchema.superRefine((value, context) => {
  validateVerifiedIdentity(value, context);
  const asset = findStockTokenTradeHistoryAsset(value.officialAsset.member.contractAddress);
  if (
    asset === undefined ||
    value.source.poolId !== asset.poolId ||
    value.chart.source.poolId !== asset.poolId ||
    value.chart.source.token.address !== asset.token ||
    value.chart.source.token.symbol !== asset.symbol ||
    value.chart.window !== value.window
  ) {
    context.addIssue({ code: "custom", message: "Stock Token trade history differs from its registered pair." });
  }
});

const validatedTradeHistoryUnavailableSchema = tradeHistoryUnavailableSchema.superRefine((value, context) => {
  validateVerifiedIdentity(value, context);
  const asset = findStockTokenTradeHistoryAsset(value.officialAsset.member.contractAddress);
  if ((value.reason === "asset_not_supported") !== (asset === undefined)) {
    context.addIssue({ code: "custom", message: "Stock Token trade-history availability is inconsistent." });
  }
});

const validatedStockFactoryUnavailableSchema = stockFactoryUnavailableSchema.superRefine((value, context) => {
  const member = value.officialAsset.member;
  if (
    value.symbol !== member.sourceSymbol ||
    value.block.chainId !== productChainId ||
    value.stockFactory.member.assetUid !== member.assetUid ||
    value.stockFactory.member.contractAddress !== member.contractAddress
  ) {
    context.addIssue({ code: "custom", message: "StockFactory unavailable result is inconsistent." });
  }
});

export const stockTokenTradeHistoryResultSchema = z.union([
  officialAssetNotFoundSchema,
  officialAssetSymbolAmbiguousSchema.superRefine((value, context) => {
    if (
      new Set(value.candidateAssetUids).size !== value.candidateAssetUids.length ||
      value.candidateAssetUids.some((assetUid, index) => index > 0 &&
        compareCodePointSequences(value.candidateAssetUids[index - 1]!, assetUid) >= 0)
    ) {
      context.addIssue({ code: "custom", message: "Ambiguous Stock Token identities are invalid." });
    }
  }),
  validatedStockFactoryUnavailableSchema,
  validatedTradeHistoryUnavailableSchema,
  validatedTradeHistoryAvailableSchema,
]);
export type StockTokenTradeHistoryResult = z.infer<typeof stockTokenTradeHistoryResultSchema>;

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

export type StockTokenTradeHistoryOfficialAssetResolution =
  | Readonly<{ status: "resolved"; officialAsset: StockTokenTradeHistoryOfficialAsset }>
  | Extract<StockTokenTradeHistoryResult, {
      readonly status: "unavailable";
      readonly reason: "official_asset_not_found" | "official_asset_symbol_ambiguous";
    }>;
export type ResolvedStockTokenTradeHistoryOfficialAsset = Extract<
  StockTokenTradeHistoryOfficialAssetResolution,
  { readonly status: "resolved" }
>;

export const resolveStockTokenTradeHistoryOfficialAsset = (
  inputValue: unknown,
  snapshotInput: CommittedOfficialAssetSnapshot,
): StockTokenTradeHistoryOfficialAssetResolution => {
  const input = stockTokenTradeHistoryInputSchema.parse(captureCanonicalJson(inputValue));
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
      candidateAssetUids: candidates.map((member) => member.assetUid).sort(compareCodePointSequences),
    });
  }
  return deepFreezeValue({
    status: "resolved",
    officialAsset: { member: candidates[0]!, snapshot: evidence },
  });
};

export const createStockTokenTradeHistoryUnavailableAfterStockFactoryRead = (input: Readonly<{
  request: StockTokenTradeHistoryInput;
  resolution: ResolvedStockTokenTradeHistoryOfficialAsset;
  block: ChainAnchor;
  stockFactory: z.infer<typeof unavailableStockFactoryResultSchema>;
}>): StockTokenTradeHistoryResult => parseStockTokenTradeHistoryResult(input.request, {
  status: "unavailable",
  reason: "stock_factory_unavailable",
  symbol: input.request.symbol,
  window: input.request.window,
  officialAsset: input.resolution.officialAsset,
  block: input.block,
  stockFactory: input.stockFactory,
});

export const createStockTokenTradeHistoryResult = (input: Readonly<{
  request: StockTokenTradeHistoryInput;
  resolution: ResolvedStockTokenTradeHistoryOfficialAsset;
  block: ChainAnchor;
  stockFactory: StockFactoryVerification;
  data: StockTokenTradeHistoryData;
}>): StockTokenTradeHistoryResult => {
  const { status, ...data } = input.data;
  return parseStockTokenTradeHistoryResult(input.request, {
    status,
    symbol: input.request.symbol,
    window: input.request.window,
    officialAsset: input.resolution.officialAsset,
    block: input.block,
    stockFactory: input.stockFactory,
    ...data,
  });
};

export const parseStockTokenTradeHistoryResult = (
  inputValue: unknown,
  resultValue: unknown,
): StockTokenTradeHistoryResult => {
  const input = stockTokenTradeHistoryInputSchema.parse(captureCanonicalJson(inputValue));
  const result = stockTokenTradeHistoryResultSchema.parse(captureCanonicalJson(resultValue));
  if (result.symbol !== input.symbol || result.window !== input.window) {
    throw new TypeError("Stock Token trade-history result does not match its request.");
  }
  return deepFreezeValue(result);
};

export const stockTokenTradeHistoryInterval = (
  window: MarketTimeWindow,
  blockTimestamp: string,
): StockTokenTradeHistoryInterval => {
  const requestedEnd = Date.parse(blockTimestamp);
  return Object.freeze({
    requestedStart: new Date(
      requestedEnd - marketTimeWindowDefinitions[window].durationMilliseconds,
    ).toISOString(),
    requestedEnd: new Date(requestedEnd).toISOString(),
  });
};

export type StockTokenTradeHistoryInterval = Readonly<{
  requestedStart: string;
  requestedEnd: string;
}>;
