import {deepFreezeValue} from "../core/index.js";
import {type ChainAnchor} from "../evm/primitives.js";
import {
  projectOfficialAssetSnapshotEvidence,
  type CommittedOfficialAssetSnapshot,
  type StockFactoryVerification,
  type StockFactoryVerificationResult,
} from "../registry/index.js";
import {
  assertStockTokenTradeHistoryData,
  deriveStockTokenTradeHistoryArchiveFreshness,
  stockTokenTradeHistoryOfficialAssetSchema,
  stockTokenTradeHistoryRequestAtBlock,
  type StockTokenTradeHistoryData,
} from "./result.js";
import type { StockTokenTradeHistoryInput } from "./period-contract.js";
import {
  admitStockTokenTradeHistorySourceResult,
  deriveStockTokenTradeHistoryPublicData,
  type StockTokenTradeHistorySourceResult,
} from "./source-semantics.js";

type StockTokenTradeHistoryOfficialResolution =
  | Readonly<{ readonly status: "unavailable"; readonly data: StockTokenTradeHistoryData }>
  | Readonly<{
      readonly status: "resolved";
      readonly officialAsset: ReturnType<typeof stockTokenTradeHistoryOfficialAssetSchema.parse>;
    }>;

export const resolveStockTokenTradeHistoryOfficialAsset = (
  input: StockTokenTradeHistoryInput,
  snapshotInput: CommittedOfficialAssetSnapshot,
): StockTokenTradeHistoryOfficialResolution => {
  const evidence = projectOfficialAssetSnapshotEvidence(snapshotInput);
  const matches = snapshotInput.members.filter((member) => member.sourceSymbol === input.symbol);
  if (matches.length === 0) {
    return Object.freeze({
      status: "unavailable",
      data: assertStockTokenTradeHistoryData(input, {
        status: "unavailable",
        reason: "official_asset_not_found",
        symbol: input.symbol,
        period: input.period,
        snapshot: evidence,
      }),
    });
  }
  if (matches.length > 1) {
    return Object.freeze({
      status: "unavailable",
      data: assertStockTokenTradeHistoryData(input, {
        status: "unavailable",
        reason: "official_asset_symbol_ambiguous",
        symbol: input.symbol,
        period: input.period,
        snapshot: evidence,
        candidateAssetUids: matches.map((member) => member.assetUid).sort(),
      }),
    });
  }
  return Object.freeze({
    status: "resolved",
    officialAsset: deepFreezeValue(stockTokenTradeHistoryOfficialAssetSchema.parse({
      member: matches[0],
      snapshot: evidence,
    })),
  });
};

export const createStockTokenTradeHistoryStockFactoryUnavailable = (input: Readonly<{
  readonly request: StockTokenTradeHistoryInput;
  readonly officialAsset: ReturnType<typeof stockTokenTradeHistoryOfficialAssetSchema.parse>;
  readonly block: ChainAnchor;
  readonly stockFactory: Extract<StockFactoryVerificationResult, { readonly status: "unavailable" }>;
}>): StockTokenTradeHistoryData => assertStockTokenTradeHistoryData(input.request, {
  status: "unavailable",
  reason: "stock_factory_unavailable",
  symbol: input.request.symbol,
  period: input.request.period,
  officialAsset: input.officialAsset,
  block: input.block,
  stockFactory: input.stockFactory,
});

export const createStockTokenTradeHistoryDecimalsUnavailable = (input: Readonly<{
  readonly request: StockTokenTradeHistoryInput;
  readonly officialAsset: ReturnType<typeof stockTokenTradeHistoryOfficialAssetSchema.parse>;
  readonly block: ChainAnchor;
  readonly stockFactory: StockFactoryVerification;
}>): StockTokenTradeHistoryData => assertStockTokenTradeHistoryData(input.request, {
  status: "unavailable",
  reason: "token_decimals_unavailable",
  symbol: input.request.symbol,
  period: input.request.period,
  officialAsset: input.officialAsset,
  block: input.block,
  stockFactory: input.stockFactory,
  tokenDecimals: { status: "unavailable", reason: "call_reverted" },
});

export const createStockTokenTradeHistoryArchiveResult = (input: Readonly<{
  readonly request: StockTokenTradeHistoryInput;
  readonly officialAsset: ReturnType<typeof stockTokenTradeHistoryOfficialAssetSchema.parse>;
  readonly block: ChainAnchor;
  readonly stockFactory: StockFactoryVerification;
  readonly tokenDecimals: number;
  readonly source: StockTokenTradeHistorySourceResult;
}>): StockTokenTradeHistoryData => {
  const request = stockTokenTradeHistoryRequestAtBlock(input.request, input.block);
  const sourceInput = {
    baseCurrencyAddress: input.officialAsset.member.contractAddress,
    baseCurrencyDecimals: input.tokenDecimals,
    requestedStart: request.requestedStart,
    requestedEnd: request.requestedEnd,
    canonicalBlock: input.block,
    resolution: request.resolution.label,
  } as const;
  const source = admitStockTokenTradeHistorySourceResult(sourceInput, input.source);
  const common = {
    symbol: input.request.symbol,
    period: input.request.period,
    officialAsset: input.officialAsset,
    block: input.block,
    stockFactory: input.stockFactory,
    tokenDecimals: { status: "available" as const, value: input.tokenDecimals },
    ...request,
  };
  if (source.status === "unavailable") {
    return assertStockTokenTradeHistoryData(input.request, {
      status: "unavailable",
      ...common,
      archive: source,
      freshness: deriveStockTokenTradeHistoryArchiveFreshness({
        requestedEnd: request.requestedEnd,
        ...(source.scope === "catalog_root"
          ? {}
          : { currentUntil: source.root.currentUntil.timestamp }),
      }),
    });
  }
  const publicData = deriveStockTokenTradeHistoryPublicData({
    sourceInput,
    coverage: source.coverage,
    resolutionOwnerMonths: source.resolutionMembers.map((entry) => entry.ownerMonth),
    candles: source.candles,
  });
  const requestedFrom = publicData.requestedCoverage[0];
  const requestedUntil = publicData.requestedCoverage.at(-1);
  if (requestedFrom === undefined || requestedUntil === undefined) {
    throw new TypeError("Available trade history has no requested coverage.");
  }
  const requiredPoolIds = new Set<string>(
    publicData.positions.flatMap((position) => position.poolId === null
      ? []
      : [position.poolId]),
  );
  const pools = Object.fromEntries(Object.entries(source.pools)
    .filter(([poolId]) => requiredPoolIds.has(poolId)));
  const data = {
    status: "available" as const,
    ...common,
    archive: {
      observedAt: source.observedAt,
      root: source.root,
      base: source.base,
      monthMembers: [...source.monthMembers],
      resolutionMembers: [...source.resolutionMembers],
      pools,
    },
    freshness: deriveStockTokenTradeHistoryArchiveFreshness({
      requestedEnd: request.requestedEnd,
      currentUntil: source.root.currentUntil.timestamp,
    }),
    coverage: {
      ...publicData.coverageSummary,
      fromTimestamp: requestedFrom.fromTimestamp,
      untilTimestamp: requestedUntil.untilTimestamp,
    },
    positions: [...publicData.positions],
  };
  return assertStockTokenTradeHistoryData(input.request, data);
};
