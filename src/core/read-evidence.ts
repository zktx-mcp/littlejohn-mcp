import {type BoundEvidenceClaimRoleDeclaration, type BoundEvidenceObservationSlotDeclaration, type ConclusionDraft, type FactRequirement, type ObservationExpectation, type ObservationReference} from "./evidence-replay.js";
import type {CanonicalJson} from "./canonical-json.js";
import type {FactOutcome, Freshness} from "./evidence.js";
import type {ObservationClaim} from "./evidence-replay.js";
import {jsonObject} from "./json-object.js";
import {createPrimitiveSchemaSet, sortUniqueStrings, type SnakeCaseCode} from "./primitives.js";

export const capabilityPrimitives = createPrimitiveSchemaSet();

export const canonicalFailureCodes = (codes: readonly string[]): readonly SnakeCaseCode[] => Object.freeze(
  sortUniqueStrings(codes.map((code) => capabilityPrimitives.snakeCaseCode.parse(code))),
);

export const readBoundaryFailureCodes = canonicalFailureCodes([
  "internal_error",
  "invalid_input",
  "port_conflict",
  "request_aborted",
  "runtime_busy",
  "runtime_state_unavailable",
]);

export const semanticReadFailureCodes = canonicalFailureCodes([
  ...readBoundaryFailureCodes,
  "result_too_large",
]);

export const noInputSchema = jsonObject({}).strict();

export const requirement = (
  fact: FactRequirement["fact"],
  outcome: FactOutcome,
  observationSlots: readonly BoundEvidenceObservationSlotDeclaration[],
  requiredObservationSlots: readonly BoundEvidenceObservationSlotDeclaration[] =
    observationSlots,
  minimumObservationCount = requiredObservationSlots.length,
): FactRequirement => ({
  fact,
  observationSlots,
  requiredObservationSlots,
  minimumObservationCount,
  outcome,
});

export const claim = (
  role: BoundEvidenceClaimRoleDeclaration,
  value: CanonicalJson,
  options: Partial<Pick<ObservationClaim, "asset" | "chainAnchor">> = {},
): ObservationClaim => ({ role, value, ...options });

export const expectation = (
  slot: BoundEvidenceObservationSlotDeclaration,
  claims: readonly ObservationClaim[],
): ObservationExpectation => ({
  slot,
  claims,
});

export const asJson = (value: unknown): CanonicalJson => value as CanonicalJson;

export const conclusionFromFact = (
  conclusion: ConclusionDraft["conclusion"],
  fact: ConclusionDraft["outcomeFact"],
  freshnessRuleId: Freshness["ruleId"],
  evidenceFacts: readonly ConclusionDraft["outcomeFact"][] = [fact],
): ConclusionDraft => ({
  conclusion,
  outcomeFact: fact,
  evidenceFacts,
  freshnessRuleId,
});

export const observationReference = (
  observationId: ObservationReference["observationId"],
  slot: BoundEvidenceObservationSlotDeclaration,
  role: BoundEvidenceClaimRoleDeclaration,
): ObservationReference => ({ observationId, slot, role });
