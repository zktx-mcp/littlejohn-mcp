import { captureCanonicalJson, createEvidenceFactIdentityDeclaration, createEvidenceObservationTargetDeclaration, createExactConclusionIdentityDeclaration, staticScopeExclusionSchema, type CapabilityId, type ConclusionDraft, type EvidenceReplayBinder, type EvidenceReplayDeclaration, type FactRequirement, type ObservationExpectation } from "../core/client.js";
import { createEvmEvidenceReplayDefinition } from "../evm/evidence-replay.js";
import {type ChainAnchor} from "../evm/primitives.js";
import type { StockTokenTradeHistoryInput } from "./period-contract.js";
import type { StockTokenTradeHistoryData } from "./result.js";

const observed = (
  fact: FactRequirement["fact"],
  slot: FactRequirement["observationSlots"][number],
  outcome: FactRequirement["outcome"],
): FactRequirement => Object.freeze({
  fact,
  outcome,
  observationSlots: [slot],
  requiredObservationSlots: [slot],
  minimumObservationCount: 1,
});

const notRequested = (
  fact: FactRequirement["fact"],
  slot: FactRequirement["observationSlots"][number],
): FactRequirement => Object.freeze({
  fact,
  outcome: "not_requested",
  observationSlots: [slot],
  requiredObservationSlots: [],
  minimumObservationCount: 0,
});

const draft = (
  conclusion: ConclusionDraft["conclusion"],
  outcomeFact: ConclusionDraft["outcomeFact"],
  evidenceFact: ConclusionDraft["evidenceFacts"][number],
  freshnessRuleId: ConclusionDraft["freshnessRuleId"],
): ConclusionDraft => Object.freeze({
  conclusion,
  outcomeFact,
  evidenceFacts: [evidenceFact],
  freshnessRuleId,
});

const createStockTokenTradeHistoryOfficialObservationClaim = (
  data: StockTokenTradeHistoryData,
) => captureCanonicalJson("officialAsset" in data
  ? { snapshot: data.officialAsset.snapshot, member: data.officialAsset.member }
  : {
      snapshot: data.snapshot,
      symbol: data.symbol,
      ...(data.reason === "official_asset_symbol_ambiguous"
        ? { candidateAssetUids: data.candidateAssetUids }
        : {}),
    });

const createStockTokenTradeHistoryStockFactoryObservationClaim = (
  data: Extract<StockTokenTradeHistoryData, { readonly officialAsset: unknown }>,
) => captureCanonicalJson({
  member: data.officialAsset.member,
  result: "reason" in data && data.reason === "stock_factory_unavailable"
    ? data.stockFactory
    : { status: "verified", verification: data.stockFactory },
});

const createStockTokenTradeHistoryDecimalsObservationClaim = (
  data: Extract<StockTokenTradeHistoryData, { readonly tokenDecimals: unknown }>,
) => captureCanonicalJson({
  address: data.officialAsset.member.contractAddress,
  result: data.tokenDecimals,
});

const createStockTokenTradeHistoryArchiveObservationClaim = (
  data: Extract<StockTokenTradeHistoryData, { readonly archive: unknown }>,
) => captureCanonicalJson(data.status === "available"
  ? {
      archive: data.archive,
      freshness: data.freshness,
      coverage: data.coverage,
      positions: data.positions,
    }
  : { archive: data.archive, freshness: data.freshness });

type EvidenceStage = Readonly<{
  readonly reached: boolean;
  readonly claim?: ReturnType<typeof captureCanonicalJson>;
  readonly chainAnchor?: ChainAnchor;
  readonly outcome: FactRequirement["outcome"];
  readonly freshnessRuleId: ConclusionDraft["freshnessRuleId"];
}>;

export const projectStockTokenTradeHistoryEvidenceStages = (
  data: StockTokenTradeHistoryData,
): Readonly<{
  readonly official: EvidenceStage;
  readonly stockFactory: EvidenceStage;
  readonly decimals: EvidenceStage;
  readonly archive: EvidenceStage;
}> => {
  const stockReached = "officialAsset" in data;
  const decimalsReached = "tokenDecimals" in data;
  const archiveReached = "archive" in data;
  const stockInconsistent = stockReached && "reason" in data &&
    data.reason === "stock_factory_unavailable" && [
      "factory_identity_mismatch",
      "source_inconsistent",
      "token_identity_mismatch",
    ].includes(data.stockFactory.reason);
  const archiveOutcome: FactRequirement["outcome"] = !archiveReached
    ? "not_requested"
    : data.status === "available" || [
        "asset_not_supported",
        "outside_published_coverage",
      ].includes(data.archive.reason)
      ? "observed"
      : data.archive.reason === "trade_history_inconsistent"
        ? "source_inconsistent"
        : "source_failed";
  const archiveFreshness = !archiveReached || data.freshness === "unknown"
    ? "trade_history_archive_unavailable" as const
    : data.freshness === "current"
      ? "trade_history_archive_current" as const
      : "trade_history_archive_stale" as const;
  const official: EvidenceStage = Object.freeze({
    reached: true,
    claim: createStockTokenTradeHistoryOfficialObservationClaim(data),
    outcome: "observed",
    freshnessRuleId: "official_asset_snapshot_current",
  });
  const stockFactory: EvidenceStage = stockReached
    ? Object.freeze({
        reached: true,
        claim: createStockTokenTradeHistoryStockFactoryObservationClaim(data),
        chainAnchor: data.block,
        outcome: stockInconsistent ? "source_inconsistent" :
          "reason" in data && data.reason === "stock_factory_unavailable"
            ? "source_failed"
            : "observed",
        freshnessRuleId: "chain_anchor_exact",
      })
    : Object.freeze({
        reached: false,
        outcome: "not_requested",
        freshnessRuleId: official.freshnessRuleId,
      });
  const decimals: EvidenceStage = decimalsReached
    ? Object.freeze({
        reached: true,
        claim: createStockTokenTradeHistoryDecimalsObservationClaim(data),
        chainAnchor: data.block,
        outcome: data.tokenDecimals.status === "unavailable" ? "source_failed" : "observed",
        freshnessRuleId: "chain_anchor_exact",
      })
    : Object.freeze({
        reached: false,
        outcome: "not_requested",
        freshnessRuleId: stockFactory.freshnessRuleId,
      });
  const archive: EvidenceStage = archiveReached
    ? Object.freeze({
        reached: true,
        claim: createStockTokenTradeHistoryArchiveObservationClaim(data),
        outcome: archiveOutcome,
        freshnessRuleId: archiveFreshness,
      })
    : Object.freeze({
        reached: false,
        outcome: "not_requested",
        freshnessRuleId: decimals.freshnessRuleId,
      });
  return Object.freeze({ official, stockFactory, decimals, archive });
};

export const createStockTokenTradeHistoryEvidence = (
  capabilityId: CapabilityId,
) => {
  const conclusions = Object.freeze({
    official: createExactConclusionIdentityDeclaration("official_asset_snapshot_current"),
    stockFactory: createExactConclusionIdentityDeclaration("stock_factory_verified"),
    decimals: createExactConclusionIdentityDeclaration("token_decimals_observed"),
    archive: createExactConclusionIdentityDeclaration("trade_history_archive_observed"),
  });
  const definition = createEvmEvidenceReplayDefinition({
    capabilityId,
    conclusions: Object.values(conclusions),
    warningCodes: [],
  });
  const facts = Object.freeze({
    official: createEvidenceFactIdentityDeclaration(definition, "official_asset_snapshot"),
    stockFactory: createEvidenceFactIdentityDeclaration(definition, "stock_factory"),
    decimals: createEvidenceFactIdentityDeclaration(definition, "token_decimals"),
    archive: createEvidenceFactIdentityDeclaration(definition, "trade_history_archive"),
  });
  const targets = Object.freeze({
    official: createEvidenceObservationTargetDeclaration(definition, {
      slotId: "official_asset_snapshot",
      fact: facts.official,
      kind: "source",
      purpose: "official_asset_snapshot",
      sourceClass: "web_api",
      roles: { value: "official_asset_snapshot" },
    }),
    stockFactory: createEvidenceObservationTargetDeclaration(definition, {
      slotId: "stock_factory",
      fact: facts.stockFactory,
      kind: "source",
      purpose: "stock_factory",
      sourceClass: "chain_rpc",
      roles: { value: "stock_factory" },
    }),
    decimals: createEvidenceObservationTargetDeclaration(definition, {
      slotId: "token_decimals",
      fact: facts.decimals,
      kind: "source",
      purpose: "token_decimals",
      sourceClass: "chain_rpc",
      roles: { value: "token_decimals" },
    }),
    archive: createEvidenceObservationTargetDeclaration(definition, {
      slotId: "trade_history_archive",
      fact: facts.archive,
      kind: "source",
      purpose: "trade_history_archive",
      sourceClass: "public_dataset",
      roles: { value: "trade_history_archive" },
    }),
  });
  const declaration = (
    _input: StockTokenTradeHistoryInput,
    data: StockTokenTradeHistoryData,
    binder: EvidenceReplayBinder,
  ): EvidenceReplayDeclaration => {
    const bound = Object.freeze({
      official: binder.bind(targets.official),
      stockFactory: binder.bind(targets.stockFactory),
      decimals: binder.bind(targets.decimals),
      archive: binder.bind(targets.archive),
    });
    const stages = projectStockTokenTradeHistoryEvidenceStages(data);
    const observationExpectations: ObservationExpectation[] = [{
      slot: bound.official.slot,
      claims: [{
        role: bound.official.roles.value,
        value: stages.official.claim!,
      }],
    }];
    if (stages.stockFactory.reached && stages.stockFactory.claim !== undefined) {
      observationExpectations.push({
      slot: bound.stockFactory.slot,
      claims: [{
        role: bound.stockFactory.roles.value,
        value: stages.stockFactory.claim,
        chainAnchor: stages.stockFactory.chainAnchor!,
      }],
      });
    }
    if (stages.decimals.reached && stages.decimals.claim !== undefined) {
      observationExpectations.push({
      slot: bound.decimals.slot,
      claims: [{
        role: bound.decimals.roles.value,
        value: stages.decimals.claim,
        chainAnchor: stages.decimals.chainAnchor!,
      }],
      });
    }
    if (stages.archive.reached && stages.archive.claim !== undefined) {
      observationExpectations.push({
      slot: bound.archive.slot,
      claims: [{
        role: bound.archive.roles.value,
        value: stages.archive.claim,
      }],
      });
    }
    const stockSupport = stages.stockFactory.reached ? facts.stockFactory : facts.official;
    const decimalsSupport = stages.decimals.reached ? facts.decimals : stockSupport;
    const archiveSupport = stages.archive.reached ? facts.archive : decimalsSupport;
    return Object.freeze({
      observationExpectations: Object.freeze(observationExpectations),
      observationReferences: [],
      factRequirements: Object.freeze([
        observed(facts.official, bound.official.slot, stages.official.outcome),
        stages.stockFactory.reached
          ? observed(facts.stockFactory, bound.stockFactory.slot, stages.stockFactory.outcome)
          : notRequested(facts.stockFactory, bound.stockFactory.slot),
        stages.decimals.reached
          ? observed(facts.decimals, bound.decimals.slot, stages.decimals.outcome)
          : notRequested(facts.decimals, bound.decimals.slot),
        stages.archive.reached
          ? observed(facts.archive, bound.archive.slot, stages.archive.outcome)
          : notRequested(facts.archive, bound.archive.slot),
      ]),
      conclusionDrafts: Object.freeze([
        draft(
          conclusions.official,
          facts.official,
          facts.official,
          stages.official.freshnessRuleId,
        ),
        draft(
          conclusions.stockFactory,
          facts.stockFactory,
          stockSupport,
          stages.stockFactory.freshnessRuleId,
        ),
        draft(
          conclusions.decimals,
          facts.decimals,
          decimalsSupport,
          stages.decimals.freshnessRuleId,
        ),
        draft(
          conclusions.archive,
          facts.archive,
          archiveSupport,
          stages.archive.freshnessRuleId,
        ),
      ]),
      warningRequirements: [],
    });
  };
  const staticScopeExclusions = Object.freeze([
    {
      id: "other_pools",
      message: "This capability does not establish activity in another Pool.",
    },
    {
      id: "underlying_equity_activity",
      message: "This capability does not establish activity in the legal underlying equity.",
    },
    {
      id: "future_availability",
      message: "This capability does not establish future trade availability.",
    },
    {
      id: "transaction_lifecycle",
      message: "This capability does not construct, simulate, review, execute, or confirm a transaction.",
    },
  ].map((value) => Object.freeze(staticScopeExclusionSchema.parse(value))));
  return Object.freeze({
    definition,
    targets,
    observationTargets: () => Object.values(targets),
    declaration,
    staticScopeExclusions,
  });
};
