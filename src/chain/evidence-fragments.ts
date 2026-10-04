import { createEvidenceFactIdentityDeclaration, createEvidenceObservationTargetDeclaration, createExactConclusionIdentityDeclaration, readEvidenceReplayCapabilityId } from "../core/client.js";
import { type EvidenceClaimRoleDeclaration, type EvidenceFactIdentityDeclaration, type EvidenceObservationTargetDeclaration, type EvidenceReplayDefinition, type ExactConclusionIdentityDeclaration } from "../core/client.js";
import {staticScopeExclusionSchema, type FactOutcome, type Freshness, type StaticScopeExclusion} from "../core/client.js";

export interface ConfiguredChainEvidenceFragment {
  readonly fact: EvidenceFactIdentityDeclaration;
  readonly target: EvidenceObservationTargetDeclaration<{
    readonly chainId: EvidenceClaimRoleDeclaration;
  }>;
  readonly outcome: FactOutcome;
  readonly freshnessRuleId: Freshness["ruleId"];
}

export const createConfiguredChainEvidenceFragment = (
  definition: EvidenceReplayDefinition,
): ConfiguredChainEvidenceFragment => {
  const fact = createEvidenceFactIdentityDeclaration(definition, "rpc_chain_id");
  return Object.freeze({
    fact,
    target: createEvidenceObservationTargetDeclaration(definition, {
      slotId: "rpc_chain_id",
      fact,
      kind: "source",
      purpose: "chain_id",
      sourceClass: "chain_rpc",
      roles: { chainId: "chain_id" },
    }),
    outcome: "observed",
    freshnessRuleId: "chain_anchor_exact",
  });
};
