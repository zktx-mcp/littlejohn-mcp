import {
  captureCanonicalJson, createEvidenceFactIdentityDeclaration, createEvidenceObservationTargetDeclaration,
  createEvidenceReplayDefinition, createExactConclusionIdentityDeclaration, sourceReferenceSchema,
  staticScopeExclusionSchema,
  type CapabilityId, type EvidenceReplayBinder, type EvidenceReplayDeclaration, type FactRequirement,
  type ObservationExpectation, type ChainAnchor, type Freshness,
} from "../core/client.js";
import { officialAssetSourceDefinition } from "../registry/official-asset-contract.js";
import type { StockTokenPricesData, StockTokenPricesInput, StockTokensData } from "./result.js";

const officialSource = {
  sourceClass: "web_api" as const, owner: officialAssetSourceDefinition.sourceOwner,
  reference: sourceReferenceSchema.parse({ kind: "public", sourceId: officialAssetSourceDefinition.sourceId, uri: officialAssetSourceDefinition.sourceUri }),
};

const exclusions = Object.freeze([
  { id: "complete_market_inventory", message: "Candidate-source coverage does not establish every pool or the best market price." },
  { id: "execution_quote", message: "A pool spot price is not an executable quote, price impact estimate, equity price or USD conversion." },
  { id: "transaction_authority", message: "This read grants no transaction, signing or wallet authority." },
].map((value) => Object.freeze(staticScopeExclusionSchema.parse(value))));

type Stage = Readonly<{
  claim?: ReturnType<typeof captureCanonicalJson>;
  block?: ChainAnchor;
  outcome: FactRequirement["outcome"];
  source?: ObservationExpectation["source"];
  freshness: Freshness["ruleId"];
}>;
export const stockTokenPriceEvidenceStages = (data: StockTokenPricesData) => {
  const official: Stage = {
    claim: captureCanonicalJson({ snapshot: data.snapshot,
      members: data.status === "selection_unavailable" ? data.candidates : [data.member] }),
    outcome: "observed", source: officialSource, freshness: "official_asset_snapshot_current",
  };
  const candidates: Stage = data.status === "selection_unavailable"
    ? { outcome: "not_requested", freshness: official.freshness }
    : { claim: captureCanonicalJson(data.source), outcome: "observed",
        source: { sourceClass: "web_api", owner: data.source.sourceOwner, reference: data.source.reference },
        freshness: "pool_candidate_source_observed" };
  const asset: Stage = data.status === "selection_unavailable"
    ? { outcome: "not_requested", freshness: official.freshness }
    : { claim: captureCanonicalJson({ verification: data.verification,
        decimals: data.status === "available" ? { stock: data.stockDecimals, quote: data.quoteDecimals }
          : { reason: data.reason } }), block: data.block,
        outcome: data.status === "available" ? "observed" : "source_failed", freshness: "chain_anchor_exact" };
  const attempted = data.status === "available" ? data.pools.filter((row) => row.candidate.status === "candidate") : [];
  const pools: Stage = attempted.length === 0
    ? { outcome: "not_requested", freshness: candidates.claim === undefined ? official.freshness : candidates.freshness }
    : { claim: captureCanonicalJson(attempted.map((row) => ({
        poolId: row.candidate.poolId, protocol: row.candidate.protocol,
        ...(row.status === "verified" ? { state: row.state, price: row.price }
          : { status: row.status, ...("reason" in row ? { reason: row.reason } : {}) }),
      }))), block: (data as Extract<StockTokenPricesData, { status: "available" }>).block,
        outcome: attempted.every((row) => row.status === "verified") ? "observed" : "source_failed",
        freshness: "chain_anchor_exact" };
  return { official, candidates, asset, pools } as const;
};

export const createStockTokenPriceEvidence = (capabilityId: CapabilityId) => {
  const names = ["official", "candidates", "asset", "pools"] as const;
  const conclusions = {
    official: createExactConclusionIdentityDeclaration("official_asset_membership_observed"),
    candidates: createExactConclusionIdentityDeclaration("pool_candidates_observed"),
    asset: createExactConclusionIdentityDeclaration("price_asset_inputs_verified"),
    pools: createExactConclusionIdentityDeclaration("pool_price_reads_complete"),
  };
  const definition = createEvidenceReplayDefinition({ capabilityId, conclusions: Object.values(conclusions), warningCodes: [] });
  const facts = Object.fromEntries(names.map((name) => [name, createEvidenceFactIdentityDeclaration(definition, name)])) as
    Record<typeof names[number], ReturnType<typeof createEvidenceFactIdentityDeclaration>>;
  const targets = Object.fromEntries(names.map((name) => [name, createEvidenceObservationTargetDeclaration(definition, {
    slotId: name, fact: facts[name], kind: "source", purpose: name,
    sourceClass: name === "official" || name === "candidates" ? "web_api" : "chain_rpc", roles: { value: name },
  })])) as Record<typeof names[number], ReturnType<typeof createEvidenceObservationTargetDeclaration<{ value: string }>>>;
  const declaration = (_input: StockTokenPricesInput, data: StockTokenPricesData, binder: EvidenceReplayBinder): EvidenceReplayDeclaration => {
    const stages = stockTokenPriceEvidenceStages(data);
    const bound = Object.fromEntries(names.map((name) => [name, binder.bind(targets[name])])) as
      Record<typeof names[number], ReturnType<typeof binder.bind<typeof targets.official>>>;
    const support = (name: typeof names[number]) => stages[name].claim !== undefined ? name
      : name === "pools" && stages.candidates.claim !== undefined ? "candidates" : "official";
    return {
      observationExpectations: names.flatMap((name): ObservationExpectation[] => {
        const stage = stages[name];
        return stage.claim === undefined ? [] : [{ slot: bound[name].slot,
          ...(stage.source === undefined ? {} : { source: stage.source }),
          claims: [{ role: bound[name].roles.value!, value: stage.claim,
            ...(stage.block === undefined ? {} : { chainAnchor: stage.block }) }] }];
      }), observationReferences: [],
      factRequirements: names.map((name) => ({ fact: facts[name], outcome: stages[name].outcome,
        observationSlots: [bound[name].slot], requiredObservationSlots: stages[name].claim === undefined ? [] : [bound[name].slot],
        minimumObservationCount: stages[name].claim === undefined ? 0 : 1 })),
      conclusionDrafts: names.map((name) => ({ conclusion: conclusions[name], outcomeFact: facts[name],
        evidenceFacts: [facts[support(name)]], freshnessRuleId: stages[name].freshness })), warningRequirements: [],
    };
  };
  return Object.freeze({ definition, targets, declaration, observationTargets: () => Object.values(targets), staticScopeExclusions: exclusions });
};

export const createStockTokensEvidence = (capabilityId: CapabilityId) => {
  const conclusion = createExactConclusionIdentityDeclaration("official_asset_catalog_observed");
  const definition = createEvidenceReplayDefinition({ capabilityId, conclusions: [conclusion], warningCodes: [] });
  const fact = createEvidenceFactIdentityDeclaration(definition, "official_catalog");
  const target = createEvidenceObservationTargetDeclaration(definition, { slotId: "official_catalog", fact,
    kind: "source", purpose: "official_catalog", sourceClass: "web_api", roles: { value: "official_catalog" } });
  return Object.freeze({
    definition, target, observationTargets: () => [target], staticScopeExclusions: exclusions,
    declaration: (_input: unknown, data: StockTokensData, binder: EvidenceReplayBinder): EvidenceReplayDeclaration => {
      const bound = binder.bind(target);
      return {
        observationExpectations: [{ slot: bound.slot, source: officialSource, claims: [{ role: bound.roles.value, value: captureCanonicalJson(data) }] }],
        observationReferences: [], factRequirements: [{ fact, outcome: "observed", observationSlots: [bound.slot], requiredObservationSlots: [bound.slot], minimumObservationCount: 1 }],
        conclusionDrafts: [{ conclusion, outcomeFact: fact, evidenceFacts: [fact], freshnessRuleId: "official_asset_snapshot_current" }], warningRequirements: [],
      };
    },
  });
};
