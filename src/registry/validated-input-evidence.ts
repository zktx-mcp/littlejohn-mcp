import { createEvidenceFactIdentityDeclaration, createEvidenceObservationTargetDeclaration, createExactConclusionIdentityDeclaration, readEvidenceReplayCapabilityId } from "../core/client.js";
import { type EvidenceClaimRoleDeclaration, type EvidenceFactIdentityDeclaration, type EvidenceObservationTargetDeclaration, type EvidenceReplayDefinition, type ExactConclusionIdentityDeclaration } from "../core/client.js";
import {staticScopeExclusionSchema, type FactOutcome, type Freshness, type StaticScopeExclusion} from "../core/client.js";
// This owner is a persisted evidence identity, independent of product UI copy.
const validatedInputOwner = "Little John validated input";









export interface ValidatedInputEvidenceFragment {
  readonly fact: EvidenceFactIdentityDeclaration;
  readonly target: EvidenceObservationTargetDeclaration<{
    readonly input: EvidenceClaimRoleDeclaration;
  }>;
  readonly outcome: FactOutcome;
  readonly freshnessRuleId: Freshness["ruleId"];
}

export const createValidatedInputEvidenceFragment = (
  definition: EvidenceReplayDefinition,
  input: Readonly<{
    factId: string;
    slotId: string;
    purpose: string;
    roleId: string;
  }>,
): ValidatedInputEvidenceFragment => {
  const capabilityId = readEvidenceReplayCapabilityId(definition);
  const fact = createEvidenceFactIdentityDeclaration(definition, input.factId);
  return Object.freeze({
    fact,
    target: createEvidenceObservationTargetDeclaration(definition, {
      slotId: input.slotId,
      fact,
      kind: "validated_input",
      purpose: input.purpose,
      owner: validatedInputOwner,
      sourceId: `input:${capabilityId}`,
      roles: { input: input.roleId },
    }),
    outcome: "validated_input",
    freshnessRuleId: "validated_input_current",
  });
};
