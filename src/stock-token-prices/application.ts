import {assertObservationAuthorityRegistrationOwns, bindCapability, captureCanonicalJson, type HandlerInvocationContext, type InvocationBoundaryPorts, type ObservationWriter} from "../core/index.js";
import {productUsdgAsset} from "../registry/client.js";
import { normalizePinnedEvmReadFailure, type ChainInvocationContext } from "../chain/index.js";
import { projectOfficialAssetSnapshotEvidence } from "../registry/index.js";
import { CapabilityReadExecutionOwner } from "../runtime/read-execution.js";
import { PoolPriceReadError, poolPriceFailureStatus } from "../protocols/pool-price-contract.js";
import {
  stockTokenPricesCapability, stockTokensCapability, stockTokenPricesErrorRegistry,
  stockTokenPricesEvidence, stockTokensEvidence, stockTokenPricesFailureCodes,
} from "./contracts.js";
import { stockTokenPriceEvidenceStages } from "./capability-evidence.js";
import { admitPoolCandidateSourceResult, PoolCandidateSourceError } from "./source-contract.js";
import {
  priceFromPoolState, stockTokenPricesDataSchema, type PricedPool,
  type StockTokenPricesInput, type StockTokenPricesData,
} from "./result.js";
import type { StockTokenPriceApplicationPort, StockTokenPriceDependencies } from "./ports.js";

const failure = (code: typeof stockTokenPricesFailureCodes[number]) => ({ status: "failure" as const, code, issues: [] });
const mapFailure = (error: unknown, signal: AbortSignal) => {
  signal.throwIfAborted();
  if (error instanceof PoolCandidateSourceError) return failure(error.code);
  const code = normalizePinnedEvmReadFailure(error, signal);
  if (code !== undefined && code !== "not_found") return failure(code);
  throw error;
};

const classifyPoolFailure = (error: unknown, context: ChainInvocationContext, candidate: PricedPool["candidate"]): PricedPool => {
  context.signal.throwIfAborted();
  let reason: PoolPriceReadError["reason"];
  if (error instanceof PoolPriceReadError) reason = error.reason;
  else {
    const code = normalizePinnedEvmReadFailure(error, context.signal);
    if (code === "chain_response_unavailable" || code === "source_unavailable" || code === "source_inconsistent" || code === "rate_limited") reason = code;
    else throw error;
  }
  return { status: poolPriceFailureStatus(reason), candidate, reason };
};

export const createStockTokenPriceApplication = (dependencies: StockTokenPriceDependencies): StockTokenPriceApplicationPort => {
  const owner = new CapabilityReadExecutionOwner(dependencies.admission, stockTokenPricesErrorRegistry, dependencies.ownerSignal);
  const executePrices = async (
    request: StockTokenPricesInput,
    context: HandlerInvocationContext<InvocationBoundaryPorts>, observations: ObservationWriter,
  ) => {
    try {
      let candidateAuthority: import("../core/index.js").ObservationAuthority | undefined;
      const official = await dependencies.officialAssets.synchronize(context.signal);
      if (official.status === "unavailable") return failure(official.reason);
      const data = await dependencies.chainInvocations.run(context.signal, async (chainContext): Promise<StockTokenPricesData> => {
        const snapshot = projectOfficialAssetSnapshotEvidence(official.snapshot);
        const matches = official.snapshot.members.filter((member) => "symbol" in request
          ? member.sourceSymbol === request.symbol : member.contractAddress === request.tokenAddress);
        if (matches.length !== 1) return {
          status: "selection_unavailable", snapshot,
          reason: matches.length === 0 ? "official_asset_not_found" : "official_asset_ambiguous", candidates: matches,
        };
        const member = matches[0]!;
        const sourceObservation = await dependencies.source.read(member.contractAddress, chainContext.signal);
        const source = admitPoolCandidateSourceResult(member.contractAddress, sourceObservation.result);
        assertObservationAuthorityRegistrationOwns(dependencies.source.observationAuthorityRegistration,
          sourceObservation.observationAuthority, "web_api", source.reference);
        candidateAuthority = sourceObservation.observationAuthority;
        const block = await dependencies.currentBlockReads.resolveCurrentBlock(chainContext);
        const verification = await dependencies.officialAssetReads.verifyAtBlock(member, block, chainContext);
        if (verification.status === "unavailable") return {
          status: "asset_unavailable", snapshot, member, source, block: block.anchor, verification, reason: "stock_factory_unavailable",
        };
        const stock = await dependencies.protocolReads.readTokenDecimals(chainContext, block, member.contractAddress);
        const quote = await dependencies.protocolReads.readTokenDecimals(chainContext, block, productUsdgAsset.address);
        if (stock.status === "reverted" || quote.status === "reverted") return {
          status: "asset_unavailable", snapshot, member, source, block: block.anchor, verification, reason: "token_decimals_unavailable",
        };
        const stockDecimals = Number(stock.value); const quoteDecimals = Number(quote.value);
        const session = dependencies.poolReads.createSession(chainContext, block);
        const pools: PricedPool[] = [];
        for (const candidate of source.candidates) {
          chainContext.signal.throwIfAborted();
          if (candidate.status === "unsupported") { pools.push({ status: "unsupported", candidate }); continue; }
          if (candidate.status === "invalid") { pools.push({ status: "invalid", candidate, reason: "pool_identity_mismatch" }); continue; }
          try {
            if (candidate.protocol === null) throw new TypeError("Admitted candidate has no protocol.");
            const state = await session.read({ protocol: candidate.protocol, poolId: candidate.poolId, stock: member.contractAddress, quote: productUsdgAsset.address });
            pools.push({ status: "verified", candidate, state,
              price: priceFromPoolState(state, member.contractAddress, stockDecimals, quoteDecimals) });
          } catch (error) { pools.push(classifyPoolFailure(error, chainContext, candidate)); }
        }
        return { status: "available", snapshot, member, source, block: block.anchor, verification, stockDecimals, quoteDecimals, pools };
      });
      const admitted = stockTokenPricesDataSchema.parse(data);
      const stages = stockTokenPriceEvidenceStages(admitted);
      for (const name of ["official", "candidates", "asset", "pools"] as const) {
        const stage = stages[name];
        if (stage.claim === undefined) continue;
        const source = name === "official" ? dependencies.officialAssetObservationAuthority
          : name === "candidates" ? candidateAuthority : name === "pools" ? dependencies.poolReads.observationAuthority : dependencies.protocolReads.observationAuthority;
        if (source === undefined) throw new TypeError("A price observation has no owning source.");
        const bound = observations.bind(stockTokenPricesEvidence.targets[name]);
        observations.record(bound.slot, { source, claims: [{ role: bound.roles.value!, value: stage.claim,
          ...(stage.block === undefined ? {} : { chainAnchor: stage.block }) }] });
      }
      return { status: "success" as const, data: admitted };
    } catch (error) { return mapFailure(error, context.signal); }
  };
  const prices = bindCapability({
    definition: stockTokenPricesCapability, errorRegistry: stockTokenPricesErrorRegistry,
    invocationAuthority: dependencies.invocationAuthority, executionOwner: owner,
    createInvocationPorts: () => dependencies.invocationPorts, handler: executePrices,
  });
  const tokens = bindCapability({
    definition: stockTokensCapability, errorRegistry: stockTokenPricesErrorRegistry,
    invocationAuthority: dependencies.invocationAuthority, executionOwner: owner,
    createInvocationPorts: () => dependencies.invocationPorts,
    handler: async (_request, context, observations) => {
      try {
        const official = await dependencies.officialAssets.synchronize(context.signal);
        if (official.status === "unavailable") return failure(official.reason);
        const data = { snapshot: projectOfficialAssetSnapshotEvidence(official.snapshot), members: [...official.snapshot.members] };
        const bound = observations.bind(stockTokensEvidence.target);
        observations.record(bound.slot, { source: dependencies.officialAssetObservationAuthority,
          claims: [{ role: bound.roles.value, value: captureCanonicalJson(data) }] });
        return { status: "success" as const, data };
      } catch (error) { return mapFailure(error, context.signal); }
    },
  });
  return Object.freeze({ prices, tokens, close: () => owner.close() });
};
