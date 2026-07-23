import type {
  ChainInvocationContext,
  ReferenceMarketChainReadPort,
} from "../chain/index.js";
import {
  deriveReferencePairValue,
  findReferencePair,
  isReferenceObservationFresh,
  referenceMarketMappingEvidence,
  referencePriceSuccessSchema,
  referencePriceWarnings,
  type ReferencePairId,
  type ReferencePriceSuccess,
} from "../core/index.js";

export const readReferencePrice = async (
  chain: ReferenceMarketChainReadPort,
  pairId: ReferencePairId,
  context: ChainInvocationContext,
): Promise<ReferencePriceSuccess> => {
  const pair = findReferencePair(pairId);
  const block = await chain.resolveCurrentBlock(context);
  const sources = await chain.readLatestAtBlock(pair.contract.sourceIds, block, context);
  const fresh = sources.every((source) =>
    isReferenceObservationFresh(source, block.anchor.blockTimestamp));
  if (pair.contract.sourceIds.length === 2 && !fresh) {
    return referencePriceSuccessSchema.parse({
      status: "unavailable",
      reason: "derived_sources_not_fresh",
      pair,
      block: block.anchor,
      mappingEvidence: referenceMarketMappingEvidence,
      sources,
      warnings: referencePriceWarnings,
    });
  }
  const value = deriveReferencePairValue(pair, sources);
  return fresh
    ? referencePriceSuccessSchema.parse({
        status: "current",
        pair,
        block: block.anchor,
        mappingEvidence: referenceMarketMappingEvidence,
        sources,
        warnings: referencePriceWarnings,
        currentPrice: value,
      })
    : referencePriceSuccessSchema.parse({
        status: "stale",
        pair,
        block: block.anchor,
        mappingEvidence: referenceMarketMappingEvidence,
        sources,
        warnings: referencePriceWarnings,
        lastObserved: value,
      });
};
