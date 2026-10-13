import {
  bindCapability, createCanonicalClock, createCapabilityInvocationAuthority, createObservationAuthority, ObservationAuthorityRegistry,
  sourceReferenceSchema, captureCanonicalJson,
  parseCapabilityInput,
  parseCapabilitySuccess,
} from "../../src/core/index.js";
import {chainAnchorSchema} from "../../src/evm/primitives.js";
import {stockFactoryVerificationSchema} from "../../src/registry/index.js";
import {createStockTokenTradeHistorySource} from "../../src/stock-token-trade-history/source.js";
import {createStockTokenTradeHistoryCrossPoolFixture} from "../stock-token-trade-history/source-fixture.js";
import {stockTokenTradeHistoryRequestAtBlock} from "../../src/stock-token-trade-history/result.js";
import {createStockTokenTradeHistoryArchiveResult} from "../../src/stock-token-trade-history/result-builder.js";
import {projectStockTokenTradeHistoryEvidenceStages} from "../../src/stock-token-trade-history/capability-evidence.js";
import {stockTokenTradeHistoryErrorRegistry, stockTokenTradeHistoryEvidence} from "../../src/stock-token-trade-history/contracts.js";
import {createStockTokenTradeHistoryObservationAuthorities} from "../../src/stock-token-trade-history/application-factory.js";
import {invokeBinding} from "../core/capability-harness.js";
import {
  stockTokenTradeHistoryCapability,
  type StockTokenTradeHistoryData,
} from "../../src/stock-token-trade-history/index.js";
import results from "./stock-token-trade-history-results.json" with { type: "json" };

const input = parseCapabilityInput(stockTokenTradeHistoryCapability, {
  symbol: "AAPL",
  period: { count: 1, unit: "day" },
});

const available = parseCapabilitySuccess(
  stockTokenTradeHistoryCapability,
  input,
  results.available,
);
const unavailable = parseCapabilitySuccess(
  stockTokenTradeHistoryCapability,
  input,
  results.unavailable,
);

if (available.data.status !== "available" || !("block" in available.data)) {
  throw new TypeError("The admitted trade-history fixture is not available.");
}

export const stockTokenTradeHistoryFixtureBlock = available.data.block;

export const stockTokenTradeHistoryAvailableFixture = () => available;

export const stockTokenTradeHistoryUnavailableFixture = () => unavailable;

// Real archive admission supplies the coverage cases; presentation expectations
// remain independent literals in the consuming tests.
export const stockTokenTradeHistoryGapFixture = async () => {
  const baseline = available.data;
  if (baseline.status !== "available") throw new Error("Available baseline required.");
  const block = chainAnchorSchema.parse({chainId: "eip155:4663", blockNumber: "10000000", blockHash: `0x${"8".repeat(64)}`, blockTimestamp: "2027-09-01T00:01:00.000Z"});
  const input = {symbol: "AAPL", period: {count: 1, unit: "year"}} as const;
  const selected = stockTokenTradeHistoryRequestAtBlock(input, block);
  const source = createStockTokenTradeHistorySource({transport: createStockTokenTradeHistoryCrossPoolFixture().transport, now: () => new Date(block.blockTimestamp)});
  try {
    const archive = await source.read({baseCurrencyAddress: baseline.officialAsset.member.contractAddress, baseCurrencyDecimals: baseline.tokenDecimals.value,
      requestedStart: selected.requestedStart, requestedEnd: selected.requestedEnd, canonicalBlock: block, resolution: selected.resolution.label});
    const data = createStockTokenTradeHistoryArchiveResult({request: input, officialAsset: baseline.officialAsset, block,
      stockFactory: stockFactoryVerificationSchema.parse({...baseline.stockFactory, block}), tokenDecimals: baseline.tokenDecimals.value, source: archive});
    const clock = createCanonicalClock(() => block.blockTimestamp);
    const sources = createStockTokenTradeHistoryObservationAuthorities(clock);
    const rpc = createObservationAuthority({clock, sourceClass: "chain_rpc", owner: "Fixture RPC", reference: sourceReferenceSchema.parse({kind: "public", sourceId: "fixture-rpc", uri: "https://rpc.example/"})});
    const binding = bindCapability({definition: stockTokenTradeHistoryCapability, errorRegistry: stockTokenTradeHistoryErrorRegistry,
      invocationAuthority: createCapabilityInvocationAuthority(clock, block.chainId),
      createInvocationPorts: () => ({observations: new ObservationAuthorityRegistry(clock, [sources.officialAsset, sources.archive, rpc])}),
      handler: async (_input, _context, observations) => {
        const stages = projectStockTokenTradeHistoryEvidenceStages(data);
        for (const [target, stage, source] of [
          [stockTokenTradeHistoryEvidence.targets.official, stages.official, sources.officialAsset],
          [stockTokenTradeHistoryEvidence.targets.stockFactory, stages.stockFactory, rpc],
          [stockTokenTradeHistoryEvidence.targets.decimals, stages.decimals, rpc],
          [stockTokenTradeHistoryEvidence.targets.archive, stages.archive, sources.archive],
        ] as const) {
          if (!stage.reached || stage.claim === undefined) continue;
          const bound = observations.bind(target);
          observations.record(bound.slot, {source, claims: [{role: bound.roles.value, value: captureCanonicalJson(stage.claim),
            ...("chainAnchor" in stage && stage.chainAnchor !== undefined ? {chainAnchor: stage.chainAnchor} : {})}]});
        }
        return {status: "success", data};
      },
    });
    const result = await invokeBinding(stockTokenTradeHistoryCapability, binding, input);
    if (!result.ok || result.data.status !== "available") throw new Error(JSON.stringify(result));
    return result;
  } finally { await source.close(); }
};

export type StockTokenTradeHistoryFixtureData = StockTokenTradeHistoryData;
