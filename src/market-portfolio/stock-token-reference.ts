import type {
  CanonicalBlock,
  ChainInvocationContext,
  ReferenceMarketChainReadPort,
} from "../chain/index.js";
import { getChainOperationFailure } from "../chain/errors.js";
import type { MarketTimeWindow } from "../core/index.js";
import { getRuntimeOperationFailure } from "../runtime/errors.js";
import { createDirectReferenceCandleSeries } from "./candles.js";
import { getMarketPortfolioOperationFailure } from "./errors.js";
import {
  createAvailableStockTokenReferenceResult,
  createUnavailableStockTokenReferenceAfterRead,
  createUnavailableStockTokenReferenceFromFailure,
  resolveStockTokenReferenceMapping,
  stockTokenReferenceAdmissionFailureReasonSchema,
  type StockTokenMarketInterval,
  type StockTokenOfficialAssetFact,
  type StockTokenReferenceAdmissionFailureReason,
  type StockTokenReferenceResult,
} from "./stock-token-market.js";
import type { ReferenceFeedSynchronizationOwner } from "./synchronization.js";

type StockTokenReferenceChain = Pick<
  ReferenceMarketChainReadPort,
  "readStockTokenReferenceAtBlock"
>;
type StockTokenReferenceSynchronization = Pick<
  ReferenceFeedSynchronizationOwner,
  "synchronize"
>;

const directReadFailureReason = (
  error: unknown,
  context: ChainInvocationContext,
): StockTokenReferenceAdmissionFailureReason | undefined => {
  if (context.signal.aborted) return undefined;
  const failure = getChainOperationFailure(error);
  if (failure === undefined) return undefined;
  const parsed = stockTokenReferenceAdmissionFailureReasonSchema.safeParse(
    failure.error.code,
  );
  return parsed.success ? parsed.data : undefined;
};

const synchronizationFailureReason = (
  error: unknown,
  context: ChainInvocationContext,
): "source_inconsistent" | "runtime_busy" | undefined => {
  if (context.signal.aborted) return undefined;
  const chainCode = getChainOperationFailure(error)?.error.code;
  if (chainCode === "source_inconsistent") return "source_inconsistent";
  if (chainCode === "runtime_busy") return "runtime_busy";
  const marketCode = getMarketPortfolioOperationFailure(error)?.error.code;
  if (marketCode === "source_inconsistent") return "source_inconsistent";
  if (marketCode === "runtime_busy") return "runtime_busy";
  return getRuntimeOperationFailure(error)?.error.code === "runtime_busy"
    ? "runtime_busy"
    : undefined;
};

export const readStockTokenReference = async (input: Readonly<{
  officialAsset: StockTokenOfficialAssetFact;
  window: MarketTimeWindow;
  interval: StockTokenMarketInterval;
  block: CanonicalBlock;
  context: ChainInvocationContext;
  chain: StockTokenReferenceChain;
  synchronization: StockTokenReferenceSynchronization;
}>): Promise<StockTokenReferenceResult> => {
  const resolution = resolveStockTokenReferenceMapping(input.officialAsset);
  if (resolution.status === "unavailable") return resolution;
  const feedId = resolution.mapping.disposition.mapping.feed.feedId;

  let read: Awaited<ReturnType<StockTokenReferenceChain["readStockTokenReferenceAtBlock"]>>;
  try {
    read = await input.chain.readStockTokenReferenceAtBlock({
      member: input.officialAsset.member,
      feedId,
      block: input.block,
    }, input.context);
  } catch (error) {
    const reason = directReadFailureReason(error, input.context);
    if (reason === undefined) throw error;
    return createUnavailableStockTokenReferenceFromFailure({
      resolution,
      officialAsset: input.officialAsset,
      reason,
    });
  }

  if (read.status === "unavailable") {
    return createUnavailableStockTokenReferenceAfterRead({
      resolution,
      officialAsset: input.officialAsset,
      read,
    });
  }

  let synchronized: Awaited<ReturnType<StockTokenReferenceSynchronization["synchronize"]>>;
  try {
    synchronized = await input.synchronization.synchronize({
      feedId,
      block: input.block,
      requestedStartUnixSeconds: BigInt(Math.floor(
        Date.parse(input.interval.requestedStart) / 1_000,
      )),
      latest: read.latest,
      context: input.context,
    });
  } catch (error) {
    const reason = synchronizationFailureReason(error, input.context);
    if (reason === undefined) throw error;
    return createUnavailableStockTokenReferenceFromFailure({
      resolution,
      officialAsset: input.officialAsset,
      reason,
    });
  }

  const series = createDirectReferenceCandleSeries({
    feedId,
    window: input.window,
    block: input.block.anchor,
    snapshot: synchronized.snapshot,
  });
  return createAvailableStockTokenReferenceResult({
    resolution,
    officialAsset: input.officialAsset,
    block: input.block.anchor,
    read,
    series,
    snapshot: synchronized.snapshot,
    report: synchronized.report,
  });
};
